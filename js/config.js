// ===== SPIDEY CONFIG — Siddhu fills these during SETUP (see ../SETUP.md) =====
window.SPIDEY_CONFIG = {
  // Only this Gmail may use Spidey (locked by Siddhu, 2026-10-22)
  ALLOWED_EMAIL: "kazayadav@gmail.com",

  // STEP 2 DONE 2026-10-22: project spidey-512410 (kazayadav@gmail.com), consent = Testing + test user
  GOOGLE_CLIENT_ID: "216071406844-kvq42o2aetac6d9egfmmaemqaqjeoha3.apps.googleusercontent.com",

  // STEP 5 DONE 2026-10-22: Cloudflare Worker live + verified (dashboard reads real sheet data via bridge)
  WORKER_URL: "https://spidey.kazayadav.workers.dev",

  APP_VERSION: "v6"
};
