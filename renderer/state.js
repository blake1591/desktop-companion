// ============================================================
// Globals — tiny shared runtime state between modules.
// ============================================================
const Globals = {
  busy: false,          // true while an LLM exchange is in flight / animating
  isBusy() {
    return this.busy === true;
  }
};
