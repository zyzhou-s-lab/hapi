/** Run with `python3 -c <script> <run-*.wandb>`. Prints one JSON object per line. */
export const READ_WANDB_SCRIPT = String.raw`
import json, os, struct, sys, time, zlib

BLOCK = 32768
HEADER = 7
FULL, FIRST, MIDDLE, LAST = 1, 2, 3, 4

def emit(obj):
    print(json.dumps(obj), flush=True)

def fail(message):
    emit({"kind": "fatal", "message": message})
    raise SystemExit(0)

def finite(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and value == value and abs(value) != float("inf")

def varint(buf, index):
    number = 0
    shift = 0
    while index < len(buf) and shift <= 63:
        byte = buf[index]
        index += 1
        number |= (byte & 0x7f) << shift
        if byte < 128:
            return number, index
        shift += 7
    raise ValueError("varint")

def fields(buf):
    index = 0
    found = []
    while index < len(buf):
        key, index = varint(buf, index)
        field = key >> 3
        wire = key & 7
        if wire == 0:
            value, index = varint(buf, index)
            found.append((field, value))
        elif wire == 2:
            length, index = varint(buf, index)
            end = index + length
            if length < 0 or end > len(buf):
                raise ValueError("length")
            found.append((field, buf[index:end]))
            index = end
        elif wire == 1:
            index += 8
        elif wire == 5:
            index += 4
        else:
            raise ValueError("wire")
    return found

def text(value):
    return value.decode("utf-8", "replace") if isinstance(value, (bytes, bytearray)) else ""

def history_points(blob):
    items = []
    step = None
    for field, value in fields(blob):
        if field == 1 and isinstance(value, (bytes, bytearray)):
            items.append(value)
        elif field == 2 and isinstance(value, (bytes, bytearray)):
            for subfield, subvalue in fields(value):
                if subfield == 1 and isinstance(subvalue, int):
                    step = subvalue
    points = []
    for item in items:
        key = ""
        nested = []
        raw = ""
        for field, value in fields(item):
            if field == 1 and isinstance(value, (bytes, bytearray)):
                key = text(value)
            elif field == 2 and isinstance(value, (bytes, bytearray)):
                nested.append(text(value))
            elif field == 16 and isinstance(value, (bytes, bytearray)):
                raw = text(value)
        if not key:
            key = "/".join(nested)
        try:
            parsed = json.loads(raw) if raw else None
        except Exception:
            continue
        if key == "_step" and finite(parsed):
            step = parsed
        elif key and not key.startswith("_") and finite(parsed):
            points.append({"metric": key, "value": float(parsed)})
    if step is None:
        return None
    return [{"step": step, "metric": point["metric"], "value": point["value"]} for point in points]

def record_body(blob):
    history = None
    exited = False
    for field, value in fields(blob):
        if field == 2 and isinstance(value, (bytes, bytearray)):
            history = value
        elif field == 18:
            exited = True
    return history, exited

def open_checked(path):
    try:
        size = os.path.getsize(path)
    except OSError:
        raise
    if size < HEADER:
        return None
    handle = open(path, "rb")
    header = handle.read(HEADER)
    if len(header) < HEADER:
        handle.close()
        return None
    ident, magic, version = struct.unpack("<4sHB", header)
    if ident != b":W&B" or magic != 0xBEE1 or version != 0:
        handle.close()
        raise ValueError("header")
    return handle

def wait_open(path):
    while True:
        try:
            handle = open_checked(path)
        except Exception:
            fail("cannot read this run")
        if handle is not None:
            return handle
        time.sleep(0.2)

def pull(handle, index, size):
    if index > size:
        return None
    space = BLOCK - (index % BLOCK)
    if space < HEADER:
        if index + space > size:
            return None
        handle.seek(index)
        if handle.read(space) != b"\x00" * space:
            raise ValueError("pad")
        index += space
        space = BLOCK - (index % BLOCK)
    if index + HEADER > size:
        return None
    handle.seek(index)
    header = handle.read(HEADER)
    if len(header) != HEADER:
        return None
    checksum, length, kind = struct.unpack("<IHB", header)
    if kind not in (FULL, FIRST, MIDDLE, LAST) or space < HEADER + length:
        raise ValueError("record")
    if index + HEADER + length > size:
        return None
    data = handle.read(length)
    if len(data) != length:
        return None
    actual = zlib.crc32(data, zlib.crc32(bytes([kind])) & 0xFFFFFFFF) & 0xFFFFFFFF
    if actual != checksum:
        raise ValueError("crc")
    return kind, data, index + HEADER + length

def next_payload(handle, index, size):
    pulled = pull(handle, index, size)
    if pulled is None:
        return None
    kind, data, index = pulled
    if kind == MIDDLE or kind == LAST:
        return ("orphan", kind, index)
    if kind == FULL:
        return ("data", data, index)
    if kind != FIRST:
        raise ValueError("record")
    parts = [data]
    while True:
        pulled = pull(handle, index, size)
        if pulled is None:
            return None
        kind, data, index = pulled
        parts.append(data)
        if kind == LAST:
            return ("data", b"".join(parts), index)
        if kind != MIDDLE:
            raise ValueError("record")
path = sys.argv[1]
handle = wait_open(path)
offset = HEADER
last_good = HEADER
while True:
    try:
        size = os.path.getsize(path)
    except OSError:
        fail("cannot read this run")
    if size < last_good:
        emit({"kind": "reset"})
        try:
            handle.close()
        except Exception:
            pass
        handle = wait_open(path)
        offset = HEADER
        last_good = HEADER
        continue
    if offset > size:
        time.sleep(0.2)
        continue
    try:
        found = next_payload(handle, offset, size)
    except Exception:
        emit({"kind": "skip", "error": "record did not parse"})
        offset = (offset // BLOCK + 1) * BLOCK
        continue
    if found is None:
        time.sleep(0.2)
        continue
    if found[0] == "orphan":
        offset = found[2]
        continue
    payload, offset = found[1], found[2]
    last_good = offset
    try:
        history, exited = record_body(payload)
    except Exception:
        emit({"kind": "skip", "error": "record did not parse"})
        continue
    if history is not None:
        try:
            points = history_points(history)
        except Exception:
            emit({"kind": "skip", "error": "history did not parse"})
            continue
        if points is None:
            emit({"kind": "skip", "error": "history has no _step"})
            continue
        for point in points:
            emit({"kind": "point", "step": point["step"], "metric": point["metric"], "value": point["value"]})
    if exited:
        emit({"kind": "exit"})
        break
`
