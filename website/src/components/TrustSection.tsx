/**
 * Phase 46B — new benefit-oriented section between Hero and Properties
 * (did not exist before this phase). Every line is a positioning
 * statement, not a factual claim — no numbers, no years-in-business, no
 * testimonials (see Phase 46A discovery's explicit "do not invent"
 * list, still in force). Icons are hand-written inline SVG — no icon
 * library dependency.
 */

const BENEFITS = [
  {
    title: 'Curated Property Options',
    description: 'Browse residential, commercial, industrial and agricultural properties in one place.',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" aria-hidden="true">
        <rect x="3" y="9" width="7" height="11" rx="1" />
        <rect x="14" y="4" width="7" height="16" rx="1" />
        <path d="M6.5 12.5h0M17.5 8.5h0M17.5 12h0" />
      </svg>
    ),
  },
  {
    title: 'Clear Property Information',
    description: 'Property type, location, area and price presented clearly for every listing.',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" aria-hidden="true">
        <path d="M6 3h9l4 4v14a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Z" />
        <path d="M9 12h6M9 16h6" />
      </svg>
    ),
  },
  {
    title: 'Direct Enquiry',
    description: 'Reach out about any property directly, with no unnecessary steps in between.',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" aria-hidden="true">
        <path d="M4 5h16v11H8l-4 4V5Z" />
      </svg>
    ),
  },
  {
    title: 'Support During Your Search',
    description: 'Our team is available to help as you explore your property options.',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" aria-hidden="true">
        <circle cx="12" cy="8" r="3.25" />
        <path d="M5 20c0-3.5 3-6 7-6s7 2.5 7 6" />
      </svg>
    ),
  },
];

export default function TrustSection() {
  return (
    <section className="trust" aria-label="Why explore properties with Aryan Landmark">
      <div className="section-heading">
        <h2>Explore Property With Clarity</h2>
        <p>Browse available property options, understand the details, and connect directly with Aryan Landmark.</p>
      </div>

      <div className="trust__grid">
        {BENEFITS.map((benefit) => (
          <div className="trust__item" key={benefit.title}>
            <span className="trust__icon">{benefit.icon}</span>
            <h3>{benefit.title}</h3>
            <p>{benefit.description}</p>
          </div>
        ))}
      </div>
    </section>
  );
}
