import { APP_NAME } from "@classtools/shared";

export function App() {
  return (
    <main className="student-shell">
      <section className="student-card" aria-labelledby="student-title">
        <span className="student-mark" aria-hidden="true">
          C
        </span>
        <p className="eyebrow">Student Application</p>
        <h1 id="student-title">{APP_NAME}</h1>
        <p className="student-message">Phase 1 application skeleton is running.</p>
        <p className="student-help">Your teacher will share a session code when the classroom is ready.</p>
        <button className="join-button" type="button">
          Join a classroom
        </button>
      </section>
    </main>
  );
}
