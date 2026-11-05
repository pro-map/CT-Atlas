// CI's command only picks up tests/*.test.cjs, so the .mjs test beside the module never ran there.
import("../cloudflare-worker/exchange-behavior.test.mjs");
