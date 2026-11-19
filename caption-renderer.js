(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.AlleyCaptionRenderer = api;
})(typeof window !== 'undefined' ? window : globalThis, function (root) {
  'use strict';

  function create(options = {}) {
    const element = options.element;
    const document = options.document || element?.ownerDocument || root.document;
    if (!element || !element.style || typeof element.replaceChildren !== 'function'
      || !document || typeof document.createElement !== 'function'
      || typeof document.createDocumentFragment !== 'function') {
      throw new TypeError('AlleyCaptionRenderer requires a document and caption element');
    }

    let fullText = null;
    let visibleText = '';
    let revealed = 0;
    let characters = [];
    let boundaryCounts = [];
    let spans = [];
    // Unrevealed glyphs take precisely the same space as revealed ones. In
    // particular, the centered first line never follows the growing prefix.
    element.style.whiteSpace = 'pre-wrap';

    function rememberVisible(text) {
      visibleText = text;
      if (element.dataset) {
        if (element.dataset.visibleText !== text) element.dataset.visibleText = text;
      } else if (element.getAttribute('data-visible-text') !== text) element.setAttribute('data-visible-text', text);
    }

    function rebuild(text) {
      fullText = text;
      characters = Array.from(text);
      boundaryCounts = [0];
      spans = [];
      revealed = 0;
      const fragment = document.createDocumentFragment();
      let units = 0;
      characters.forEach((character, index) => {
        units += character.length;
        boundaryCounts[units] = index + 1;
        const span = document.createElement('span');
        span.className = 'caption-char';
        span.setAttribute('data-caption-char', String(index));
        span.setAttribute('data-revealed', 'false');
        span.style.visibility = 'hidden';
        span.textContent = character;
        fragment.appendChild(span);
        spans.push(span);
      });
      // A fragment avoids an argument limit for long Comic-mode paragraphs.
      element.replaceChildren(fragment);
    }

    function render(input = {}) {
      const text = typeof input.fullText === 'string' ? input.fullText : '';
      if (text !== fullText) rebuild(text);
      const candidate = typeof input.visibleText === 'string' ? input.visibleText : '';
      let count = 0;
      // Accept complete code points only. A half-surrogate prefix must not
      // expose a broken emoji or reveal an unexpected character.
      if (text.startsWith(candidate) && boundaryCounts[candidate.length] !== undefined) count = boundaryCounts[candidate.length];
      for (let index = Math.min(revealed, count); index < Math.max(revealed, count); index += 1) {
        const visible = index < count;
        spans[index].style.visibility = visible ? 'visible' : 'hidden';
        spans[index].setAttribute('data-revealed', String(visible));
      }
      revealed = count;
      rememberVisible(count ? candidate : '');
      return visibleText;
    }

    return { render, getVisibleText: () => visibleText };
  }

  return { create };
});
