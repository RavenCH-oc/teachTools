import { APP_NAME } from "@classtools/shared";

const navigationItems = ["Classroom", "Sessions", "Question Sets", "Students", "Settings"];

export function App() {
  return (
    <div className="teacher-shell">
      <header className="teacher-header">
        <div>
          <p className="eyebrow">Teacher Application</p>
          <h1>{APP_NAME}</h1>
        </div>
        <span className="phase-badge">Phase 1</span>
      </header>
      <div className="teacher-body">
        <nav aria-label="Teacher navigation" className="teacher-nav">
          {navigationItems.map((item, index) => (
            <button className={index === 0 ? "nav-item active" : "nav-item"} key={item} type="button">
              {item}
            </button>
          ))}
        </nav>
        <main className="teacher-main">
          <p className="eyebrow">Application shell</p>
          <h2>Phase 1 application skeleton is running.</h2>
          <p className="intro">
            The Teacher surface is ready for the domain and SessionBackend work planned for the next phase.
          </p>
          <section aria-label="Teacher capabilities" className="capability-grid">
            <article>
              <span className="capability-icon">01</span>
              <h3>Local-first</h3>
              <p>Local persistence will be connected in Phase 2.</p>
            </article>
            <article>
              <span className="capability-icon">02</span>
              <h3>Live sessions</h3>
              <p>SessionBackend runtime is intentionally not implemented yet.</p>
            </article>
            <article>
              <span className="capability-icon">03</span>
              <h3>Student web</h3>
              <p>Students join through the separate browser application.</p>
            </article>
          </section>
        </main>
      </div>
    </div>
  );
}
