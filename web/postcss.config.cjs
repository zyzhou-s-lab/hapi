module.exports = {
    plugins: {
        // Preserve imported declaration source paths for Vite's font URL rewriting.
        // Tailwind's optimize pass loses them; Vite still minifies the final CSS.
        '@tailwindcss/postcss': { optimize: false },
        autoprefixer: {}
    }
}
