import { useEffect, useState } from 'react';

/**
 * Text wordmark only — no logo asset exists (see Phase 43A/46A discovery).
 * Once a real logo is supplied, only the contents of `.wordmark` need to
 * change to an <img>; nothing else here depends on it being text.
 *
 * Sticky: keeps navigation reachable on a long single-page site without
 * needing a router. Anchor targets use `scroll-margin-top` (global.css)
 * so a sticky header never covers the section heading being jumped to.
 *
 * Phase 46B: adds a persistent "Get in Touch" CTA and an accessible
 * mobile menu (hamburger toggle + panel) below the 900px breakpoint
 * where the inline nav/CTA are hidden by CSS.
 */
export default function Header() {
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => {
    if (!menuOpen) return;
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') setMenuOpen(false);
    }
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [menuOpen]);

  function closeMenu() {
    setMenuOpen(false);
  }

  return (
    <header className="site-header">
      <div className="site-header__inner">
        <a className="wordmark" href="#top">
          Aryan Landmark
        </a>

        <nav className="site-nav" aria-label="Primary">
          <a href="#top">Home</a>
          <a href="#properties">Properties</a>
          <a href="#about">About</a>
          <a href="#contact">Contact</a>
        </nav>

        <div className="site-header__actions">
          <a className="button button--primary site-header__cta" href="#contact">
            Get in Touch
          </a>

          <button
            type="button"
            className="site-header__menu-toggle"
            aria-expanded={menuOpen}
            aria-controls="mobile-nav"
            aria-label={menuOpen ? 'Close menu' : 'Open menu'}
            onClick={() => setMenuOpen((open) => !open)}
          >
            <span aria-hidden="true" className={menuOpen ? 'menu-icon menu-icon--open' : 'menu-icon'} />
          </button>
        </div>
      </div>

      {menuOpen && (
        <div id="mobile-nav" className="mobile-nav">
          <nav aria-label="Mobile">
            <a href="#top" onClick={closeMenu}>
              Home
            </a>
            <a href="#properties" onClick={closeMenu}>
              Properties
            </a>
            <a href="#about" onClick={closeMenu}>
              About
            </a>
            <a href="#contact" onClick={closeMenu}>
              Contact
            </a>
          </nav>
          <a className="button button--primary" href="#contact" onClick={closeMenu}>
            Get in Touch
          </a>
        </div>
      )}
    </header>
  );
}
