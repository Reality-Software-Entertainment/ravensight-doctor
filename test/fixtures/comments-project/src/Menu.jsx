export function Menu() {
  return (
    <p>
      Don't leave yet {/* rs.track("jsx_comment") */}
      <button onClick={() => rs.track('menu_clicked')}>Stay</button>
    </p>
  );
}
