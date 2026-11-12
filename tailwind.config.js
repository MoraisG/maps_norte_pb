/**
 * Configuração do Tailwind CSS (compilado localmente; substitui o CDN JIT).
 * Gerar/atualizar o CSS após mudar classes no HTML/JS:
 *   npx tailwindcss@3.4.17 -c tailwind.config.js -i css/tailwind.input.css -o css/tailwind.css --minify
 * O CI (pr-checks) falha se o css/tailwind.css versionado estiver desatualizado.
 */
module.exports = {
  content: ["./index.html", "./js/**/*.js"],
  theme: { extend: {} },
  plugins: []
};
