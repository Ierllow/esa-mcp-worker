const SHARED_STYLES = `
  :root {
    color-scheme: light;
    font-family: "Segoe UI Variable Text", "Segoe UI", "Yu Gothic UI", "Hiragino Kaku Gothic ProN", Meiryo, sans-serif;
    color: #1f2328;
    background: #ffffff;
    font-synthesis: none;
    --ink: #1f2328;
    --muted: #656d76;
    --line: #d0d7de;
    --surface: #ffffff;
    --subtle: #f6f8fa;
    --subtle-strong: #eef1f4;
    --accent: #0969da;
    --accent-strong: #0757b7;
    --danger: #cf222e;
    --danger-strong: #a40e26;
    --warning: #9a6700;
  }
  * { box-sizing: border-box; }
  body { margin: 0; color: var(--ink); background: #fff; font-size: 14px; line-height: 1.5; letter-spacing: 0; }
  button, input, select { font: inherit; letter-spacing: 0; }
  button {
    min-height: 2.25rem;
    padding: .48rem .8rem;
    border: 1px solid var(--line);
    border-radius: 6px;
    background: var(--subtle);
    color: var(--ink);
    box-shadow: 0 1px 0 rgba(31, 35, 40, .04);
    font-weight: 600;
    cursor: pointer;
    transition: background-color 100ms ease, border-color 100ms ease, box-shadow 100ms ease;
  }
  button:hover { background: var(--subtle-strong); border-color: #afb8c1; }
  button:active { background: #e7ebef; box-shadow: inset 0 1px 0 rgba(31, 35, 40, .08); }
  button.primary { color: #fff; background: var(--accent); border-color: rgba(31, 35, 40, .15); }
  button.primary:hover { background: var(--accent-strong); border-color: rgba(31, 35, 40, .15); }
  button.primary:active { background: #064da3; }
  button:focus-visible, input:focus-visible, select:focus-visible, a:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }
  button.secondary { color: var(--ink); background: var(--subtle); border-color: var(--line); }
  button.secondary:hover { background: var(--subtle-strong); border-color: #afb8c1; }
  button.danger { color: #fff; background: var(--danger); border-color: rgba(31, 35, 40, .15); }
  button.danger:hover { background: var(--danger-strong); border-color: rgba(31, 35, 40, .15); }
  button.danger-outline { color: var(--danger); background: #fff; border-color: #ff8182; }
  button.danger-outline:hover { color: #fff; background: var(--danger); border-color: var(--danger); }
  input, select {
    min-height: 2.25rem;
    width: 100%;
    padding: .48rem .65rem;
    border: 1px solid var(--line);
    border-radius: 6px;
    color: var(--ink);
    background: #fff;
    box-shadow: inset 0 1px 2px rgba(31, 35, 40, .06);
  }
  input:focus, select:focus { border-color: var(--accent); }
  input[readonly] { font-family: "Cascadia Mono", Consolas, monospace; background: var(--subtle); }
  .brand { display: flex; align-items: center; gap: .75rem; min-width: 0; }
  .brand-mark {
    display: grid;
    width: 2.35rem;
    height: 2.35rem;
    flex: 0 0 2.35rem;
    place-items: center;
    border-radius: 6px;
    background: #24292f;
    color: #fff;
    box-shadow: 0 1px 2px rgba(31, 35, 40, .18);
    font: 700 .68rem/1 "Cascadia Mono", Consolas, monospace;
  }
  .brand-name { color: var(--muted); font-size: .75rem; font-weight: 600; }
  .muted { color: var(--muted); }
  .notice, .error { margin: 0; padding: .75rem .85rem; border: 1px solid; border-radius: 6px; }
  .notice { color: #1a7f37; background: #dafbe1; border-color: rgba(31, 35, 40, .15); }
  .error { color: #82071e; background: #ffebe9; border-color: #ff8182; }
`;

export const ADMIN_LOGIN_STYLES = `${SHARED_STYLES}
  body { min-height: 100vh; display: grid; place-items: center; padding: 1.25rem; }
  main { width: min(100%, 27rem); }
  .login-panel { padding: 2rem; border: 1px solid var(--line); border-top: 3px solid #24292f; border-radius: 7px; background: var(--surface); box-shadow: 0 8px 24px rgba(31, 35, 40, .08); }
  h1 { margin: .2rem 0 1.5rem; font-family: "Segoe UI Variable Display", "Segoe UI", sans-serif; font-size: 1.4rem; font-weight: 600; line-height: 1.2; }
  form { display: grid; gap: 1rem; margin-top: 1.25rem; }
  label { display: grid; gap: .35rem; color: #3f464d; font-size: .85rem; font-weight: 600; }
  button { width: 100%; margin-top: .25rem; }
`;

export const ADMIN_DASHBOARD_STYLES = `${SHARED_STYLES}
  .shell { width: min(100%, 94rem); margin: 0 auto; padding: 1.35rem 1.5rem 4rem; }
  .topbar { display: flex; align-items: center; justify-content: space-between; gap: 1rem; margin-bottom: 1rem; padding-bottom: 1rem; border-bottom: 1px solid var(--line); }
  .topbar h1 { margin: .12rem 0 0; font-family: "Segoe UI Variable Display", "Segoe UI", sans-serif; font-size: 1.3rem; font-weight: 600; line-height: 1.15; }
  .inline-form { display: inline; margin: 0; }
  .summary-strip { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); overflow: hidden; border: 1px solid var(--line); border-radius: 6px; background: var(--subtle); box-shadow: 0 1px 2px rgba(31, 35, 40, .04); }
  .summary-item { min-width: 0; padding: .85rem 1rem; }
  .summary-item + .summary-item { border-left: 1px solid var(--line); }
  .summary-label { display: block; margin-bottom: .22rem; color: var(--muted); font-size: .75rem; font-weight: 600; }
  .summary-value { display: block; min-height: 1.45rem; font-size: 1.05rem; font-weight: 600; overflow-wrap: anywhere; }
  .section-tabs { display: flex; gap: 1.25rem; overflow-x: auto; margin: .75rem 0 0; border-bottom: 1px solid var(--line); }
  .tab-button { flex: 0 0 auto; min-height: auto; padding: .72rem .08rem .62rem; border: 0; border-bottom: 2px solid transparent; border-radius: 0; color: var(--muted); background: transparent; box-shadow: none; font-size: .82rem; font-weight: 600; }
  .tab-button:hover { color: var(--ink); background: transparent; border-color: transparent; border-bottom-color: #afb8c1; }
  .tab-button:active { background: transparent; box-shadow: none; }
  .tab-button[aria-selected="true"] { color: var(--accent); border-bottom-color: var(--accent); }
  .tab-panel { padding: 1.6rem 0 1.9rem; }
  .tab-panel[hidden] { display: none; }
  .section-heading { display: flex; align-items: baseline; justify-content: space-between; gap: 1rem; margin-bottom: 1rem; }
  h2 { margin: 0; font-family: "Segoe UI Variable Display", "Segoe UI", sans-serif; font-size: 1.05rem; font-weight: 600; }
  h3 { margin: 0 0 .75rem; font-size: .88rem; font-weight: 600; }
  .section-meta { margin: 0; color: var(--muted); font-size: .8rem; text-align: right; }
  .access-grid { display: grid; grid-template-columns: minmax(20rem, 1.3fr) minmax(16rem, .7fr); gap: 2rem; }
  .field-actions { display: flex; align-items: stretch; gap: .5rem; max-width: 40rem; }
  .field-actions input { min-width: 0; }
  .action-row { display: flex; flex-wrap: wrap; gap: .55rem; margin-top: .7rem; }
  .key-values { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: .55rem 1rem; margin: 0 0 1rem; }
  .key-values dt { color: var(--muted); font-size: .8rem; }
  .key-values dd { margin: 0; font-size: .84rem; overflow-wrap: anywhere; }
  .grid { display: grid; grid-template-columns: repeat(2, minmax(12rem, 1fr)); gap: .8rem 1rem; max-width: 58rem; margin-bottom: 1.2rem; }
  .grid label { display: grid; gap: .32rem; color: #3f464d; font-size: .8rem; font-weight: 600; }
  .grid .wide { grid-column: 1 / -1; }
  .grid .form-actions { display: flex; justify-content: flex-start; }
  .table-wrap { width: 100%; overflow-x: auto; border: 1px solid var(--line); border-radius: 6px; background: var(--surface); box-shadow: 0 1px 2px rgba(31, 35, 40, .04); }
  table { width: 100%; min-width: 58rem; border-collapse: collapse; font-size: .79rem; }
  #events table { min-width: 96rem; }
  th, td { padding: .58rem .65rem; text-align: left; vertical-align: top; border-bottom: 1px solid #d8dee4; }
  th { position: sticky; top: 0; z-index: 1; color: #57606a; background: var(--subtle); font-size: .72rem; font-weight: 600; white-space: nowrap; }
  tbody tr:last-child td { border-bottom: 0; }
  tbody tr:hover { background: var(--subtle); }
  .mono { font-family: "Cascadia Mono", Consolas, monospace; font-size: .75rem; }
  .nowrap { white-space: nowrap; }
  .table-action { width: 1%; white-space: nowrap; }
  button.compact { min-height: 2rem; padding: .34rem .55rem; font-size: .76rem; }
  .status { display: inline-flex; align-items: center; gap: .38rem; white-space: nowrap; font-size: .76rem; font-weight: 650; }
  .status-dot { width: .48rem; height: .48rem; flex: 0 0 .48rem; border-radius: 50%; background: #89938f; }
  .status-ok { color: #2c6754; }
  .status-ok .status-dot { background: #31755e; }
  .status-warning { color: var(--warning); }
  .status-warning .status-dot { background: #d39321; }
  .status-danger { color: var(--danger); }
  .status-danger .status-dot { background: var(--danger); }
  .notice { margin-bottom: 1rem; }
  @media (max-width: 760px) {
    .shell { padding: 1rem .8rem 3rem; }
    .topbar { align-items: flex-start; }
    .summary-strip { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .summary-item:nth-child(3) { border-left: 0; border-top: 1px solid var(--line); }
    .summary-item:nth-child(4) { border-top: 1px solid var(--line); }
    .access-grid, .grid { grid-template-columns: minmax(0, 1fr); }
    .grid .wide { grid-column: auto; }
    .section-heading { align-items: flex-start; flex-direction: column; gap: .3rem; }
    .section-meta { text-align: left; }
    .field-actions { align-items: stretch; flex-direction: column; }
  }
`;
