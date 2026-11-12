/**
 * Proteção contra clickjacking. O GitHub Pages não permite enviar o cabeçalho
 * X-Frame-Options / CSP frame-ancestors, e frame-ancestors não funciona via <meta>.
 * Se a página for carregada dentro de um iframe de outro site, ela se oculta e
 * tenta assumir a janela principal.
 */
(function () {
  if (window.top === window.self) return;
  document.documentElement.style.display = "none";
  try {
    window.top.location.replace(window.self.location.href);
  } catch (e) {
    // Bloqueado pelo navegador (sandbox): a página permanece oculta dentro do iframe
  }
})();
