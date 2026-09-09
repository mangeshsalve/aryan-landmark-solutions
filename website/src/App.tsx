import Header from './components/Header';
import Hero from './components/Hero';
import TrustSection from './components/TrustSection';
import PropertyList from './components/PropertyList';
import About from './components/About';
import ContactCTA from './components/ContactCTA';
import Footer from './components/Footer';

/**
 * Phase 46B — visual redesign composition. Section order per the
 * approved Phase 46A design: Header, Hero, Trust/Value, Properties,
 * About, Contact, Footer. TrustSection is the only new section added
 * this phase; every other section is the same component, restyled.
 */
function App() {
  return (
    <>
      <Header />
      <main>
        <Hero />
        <TrustSection />
        <PropertyList />
        <About />
        <ContactCTA />
      </main>
      <Footer />
    </>
  );
}

export default App;
