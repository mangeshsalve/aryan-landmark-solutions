/**
 * No social/legal links — none exist yet, and a link that leads nowhere
 * is worse for trust than omitting it (Phase 46A discovery). Add them
 * only once real accounts/pages exist.
 */
export default function Footer() {
  const year = new Date().getFullYear();
  return (
    <footer className="site-footer">
      <div className="site-footer__inner">
        <div className="site-footer__brand">
          <a className="wordmark wordmark--footer" href="#top">
            Aryan Landmark
          </a>
          <p className="site-footer__tagline">
            Residential, commercial, industrial and agricultural properties.
          </p>
        </div>

        <div className="site-footer__row">
          <nav className="site-footer__nav" aria-label="Footer">
            <a href="#top">Home</a>
            <a href="#properties">Properties</a>
            <a href="#about">About</a>
            <a href="#contact">Contact</a>
          </nav>
          <p className="site-footer__copyright">&copy; {year} Aryan Landmark. All rights reserved.</p>
        </div>
      </div>
    </footer>
  );
}
