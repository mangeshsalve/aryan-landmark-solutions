/**
 * No real hero photography exists for this project (see Phase 43A/46A
 * discovery — no brand imagery found anywhere in the repo), so the
 * visual treatment stays CSS-only: a restrained navy panel with a fine
 * line-grid pattern (desktop only, see .hero__visual in global.css) —
 * not a stock/placeholder photo pretending to be an Aryan Landmark
 * property. Copy is deliberately factual — no superlatives, no invented
 * track record.
 */
export default function Hero() {
  return (
    <section id="top" className="hero" aria-label="Introduction">
      <div className="hero__inner">
        <div className="hero__content">
          <h1>Find a Property That Fits Your Needs</h1>
          <p>
            Explore available properties and connect directly with Aryan Landmark for your
            property requirements.
          </p>
          <div className="hero__actions">
            <a className="button button--primary button--lg" href="#properties">
              View Properties
            </a>
            <a className="button button--secondary button--lg" href="#contact">
              Get in Touch
            </a>
          </div>
        </div>
        <div className="hero__visual" aria-hidden="true">
          <div className="hero__visual-panel" />
        </div>
      </div>
    </section>
  );
}
