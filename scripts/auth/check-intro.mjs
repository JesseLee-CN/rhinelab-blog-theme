// LOGIN-IMPROVE L1b/L2a browser checks for the intro curtain, the 图三 panel,
// the handoff and the built-bundle DEV boundary.
//
// Scenarios:
//   guest         real client, GUEST only: anti-bleed, single Logo, frame 169
//   reduced       prefers-reduced-motion: direct ready -> archive
//   layout        multi-viewport organization (side/stack) + screenshots
//   query-boundary production bundle ignores review/time/freeze/entryMock
//
// No screenshots are compared automatically; layout screenshots are collected
// for the L2a visual review. Unknown arguments are rejected.
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { chromium, webkit } from "playwright";

const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) {
  const key = process.argv[i];
  if (!key.startsWith("--")) throw new Error(`unexpected argument: ${key}`);
  args.set(key.slice(2), process.argv[i + 1]);
}
const known = new Set(["base-url", "browser", "out-dir", "scenario", "port"]);
for (const key of args.keys())
  if (!known.has(key)) throw new Error(`unknown argument: --${key}`);

const scenario = args.get("scenario") ?? "guest";
if (
  !["guest", "layout", "mobile", "reduced", "query-boundary"].includes(scenario)
)
  throw new Error(`unknown scenario: ${scenario}`);

const port = Number(args.get("port") ?? 5184);
const base = args.get("base-url") ?? `http://127.0.0.1:${port}/lab/`;
const browserName = args.get("browser") ?? "chromium";
const outDir = resolve(args.get("out-dir") ?? ".tools/login-improve/L2a");
mkdirSync(outDir, { recursive: true });
const reduced = scenario === "reduced" ? "reduce" : "no-preference";

const preview =
  base.includes("127.0.0.1") && !args.get("base-url")
    ? spawn("node", ["scripts/blog/preview.mjs", String(port)], {
        stdio: "ignore",
      })
    : null;
const waitReady = async () => {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(base);
      if (res.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("preview not ready");
};

const checks = [];
const check = (name, ok, detail = "") =>
  checks.push({ name, ok: Boolean(ok), detail });

function launchBrowser() {
  if (browserName === "webkit") return webkit.launch();
  if (browserName !== "chromium")
    throw new Error(`unknown browser: ${browserName}`);
  return chromium.launch({
    args: [
      "--no-sandbox",
      "--use-gl=angle",
      "--use-angle=swiftshader",
      "--enable-unsafe-swiftshader",
    ],
  });
}

async function gotoPage(browser, viewport, query = "") {
  const page = await browser.newPage({ viewport, reducedMotion: reduced });
  page.setDefaultNavigationTimeout(90000);
  page.on("pageerror", (error) => console.error("pageerror:", error.message));
  await page.goto(`${base}${query}`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('#boot-entry[data-phase="login"]', {
    timeout: 60000,
  });
  await page.waitForFunction(
    () => window.rhine?.stats()?.introPhase === "ready",
    null,
    { timeout: 60000 },
  );
  return page;
}

async function measureLayout(page) {
  return page.evaluate(() => {
    const rect = (selector) => {
      const el = document.querySelector(selector);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return {
        x: Math.round(r.x),
        y: Math.round(r.y),
        w: Math.round(r.width),
        h: Math.round(r.height),
      };
    };
    return {
      viewport: { w: window.innerWidth, h: window.innerHeight },
      mode: document.querySelector("#boot-intro")?.dataset.introPhase,
      logo: rect("#intro-logo"),
      form: rect("#boot-entry"),
      brand: rect(".intro-brand"),
      powered: rect(".intro-powered"),
      submit: rect("#entry-submit"),
      register: rect('[data-entry="register"]'),
      guest: rect('[data-entry="guest"]'),
      overflow: document.documentElement.scrollWidth > window.innerWidth + 1,
    };
  });
}

const centerX = (rect) => rect.x + rect.w / 2;

try {
  if (preview) await waitReady();
  const browser = await launchBrowser();
  try {
    if (scenario === "layout") {
      const viewports = [
        { w: 1920, h: 1080, label: "1920x1080" },
        { w: 1366, h: 768, label: "1366x768" },
        { w: 2560, h: 1440, label: "2560x1440" },
        { w: 2048, h: 1104, label: "2048x1104" },
        // 125% browser-zoom emulation: 1920/1.25 x 1080/1.25 CSS pixels.
        { w: 1536, h: 864, label: "zoom125" },
      ];
      for (const vp of viewports) {
        const page = await gotoPage(browser, { width: vp.w, height: vp.h });
        const m = await measureLayout(page);
        check(`${vp.label}: intro reachable`, Boolean(m.logo && m.form));
        check(
          `${vp.label}: no horizontal overflow`,
          !m.overflow,
          JSON.stringify(m),
        );
        check(
          `${vp.label}: logo and form do not overlap`,
          m.logo.x + m.logo.w <= m.form.x || m.form.y >= m.logo.y + m.logo.h,
          JSON.stringify({ logo: m.logo, form: m.form }),
        );
        if (vp.w >= 1720) {
          check(
            `${vp.label}: side layout centers (logo 38%, form 60%)`,
            Math.abs(centerX(m.logo) / vp.w - 0.384) < 0.06 &&
              Math.abs(centerX(m.form) / vp.w - 0.601) < 0.06,
            JSON.stringify({
              logo: centerX(m.logo) / vp.w,
              form: centerX(m.form) / vp.w,
            }),
          );
        } else {
          check(
            `${vp.label}: stacked layout centers both blocks`,
            Math.abs(centerX(m.logo) / vp.w - 0.5) < 0.02 &&
              Math.abs(centerX(m.form) / vp.w - 0.5) < 0.02 &&
              m.form.y >= m.logo.y + m.logo.h,
            JSON.stringify({
              logo: centerX(m.logo) / vp.w,
              form: centerX(m.form) / vp.w,
            }),
          );
        }
        check(
          `${vp.label}: form width is usable`,
          m.form.w >= 280 && m.form.w <= Math.min(480, vp.w),
          String(m.form.w),
        );
        check(
          `${vp.label}: black submit row is tall enough`,
          m.submit && m.submit.h >= 44 && m.submit.w === m.form.w,
          JSON.stringify(m.submit),
        );
        check(
          `${vp.label}: bottom row keeps REGISTER left of GUEST`,
          m.register && m.guest && centerX(m.register) < centerX(m.guest),
          JSON.stringify({ register: m.register, guest: m.guest }),
        );
        check(
          `${vp.label}: corner branding is placed at the edges`,
          m.brand &&
            m.powered &&
            m.brand.y < m.logo.y &&
            m.powered.y > m.form.y,
          JSON.stringify({ brand: m.brand, powered: m.powered }),
        );
        await page.screenshot({
          path: `${outDir}/login-${vp.label}.png`,
          animations: "disabled",
        });
        await page.close();
      }
    } else if (scenario === "mobile") {
      const viewports = [
        { w: 390, h: 844 },
        { w: 844, h: 390 },
        { w: 320, h: 568 },
        { w: 568, h: 320 },
      ];
      for (const vp of viewports) {
        const context = await browser.newContext({
          viewport: { width: vp.w, height: vp.h },
          isMobile: true,
          hasTouch: true,
          reducedMotion: "no-preference",
        });
        const page = await context.newPage();
        page.setDefaultNavigationTimeout(90000);
        page.on("pageerror", (error) =>
          console.error("pageerror:", error.message),
        );
        await page.goto(base, { waitUntil: "domcontentloaded" });
        await page.waitForFunction(
          () => window.rhine?.stats()?.introPhase === "ready",
          null,
          { timeout: 60000 },
        );
        await page.waitForSelector('#boot-entry[data-phase="login"]', {
          timeout: 15000,
        });
        const label = `${vp.w}x${vp.h}`;
        const m = await measureLayout(page);
        check(
          `${label}: stacked layout`,
          m.form.y >= m.logo.y + m.logo.h,
          JSON.stringify({ logo: m.logo, form: m.form }),
        );
        check(`${label}: no horizontal overflow`, !m.overflow);
        const inputFont = await page.$eval("#entry-username", (el) =>
          parseFloat(getComputedStyle(el).fontSize),
        );
        check(
          `${label}: input font >= 16px`,
          inputFont >= 16,
          String(inputFont),
        );
        check(
          `${label}: submit >= 44px tall`,
          m.submit.h >= 44,
          String(m.submit.h),
        );
        for (const [name, sel] of [
          ["register", '[data-entry="register"]'],
          ["guest", '[data-entry="guest"]'],
        ]) {
          const box = await page.locator(sel).boundingBox();
          check(
            `${label}: ${name} target >= 44px`,
            box && box.height >= 44,
            JSON.stringify(box),
          );
        }
        check(
          `${label}: login autocomplete attributes`,
          (await page.getAttribute("#entry-username", "autocomplete")) ===
            "username" &&
            (await page.getAttribute("#entry-password", "autocomplete")) ===
              "current-password",
        );
        // Focus order inside the panel (no trap, logical order).
        await page.focus("#entry-username");
        const order = [];
        for (let i = 0; i < 4; i++) {
          await page.keyboard.press("Tab");
          order.push(
            await page.evaluate(
              () =>
                document.activeElement?.id ||
                document.activeElement?.dataset?.entry ||
                document.activeElement?.tagName,
            ),
          );
        }
        check(
          `${label}: tab order username -> password -> submit -> register -> guest`,
          order.join(",") ===
            "entry-password,entry-submit,entry-register,guest",
          order.join(","),
        );
        // Value survives rotation and the layout stays usable.
        await page.fill("#entry-username", "KeepMe");
        await page.setViewportSize({ width: vp.h, height: vp.w });
        await page.waitForTimeout(200);
        const rotated = await measureLayout(page);
        check(
          `${label}: rotation keeps the field and layout`,
          (await page.inputValue("#entry-username")) === "KeepMe" &&
            !rotated.overflow,
          JSON.stringify({ overflow: rotated.overflow }),
        );
        await page.setViewportSize({ width: vp.w, height: vp.h });
        // Register mode: confirm field, new-password, Escape returns.
        await page.locator('[data-entry="register"]').click({ timeout: 10000 });
        await page.waitForSelector('#boot-entry[data-phase="register"]');
        check(
          `${label}: confirm field reachable`,
          await page.isVisible("#entry-confirm"),
        );
        check(
          `${label}: register password uses new-password`,
          (await page.getAttribute("#entry-password", "autocomplete")) ===
            "new-password",
        );
        await page.keyboard.press("Escape");
        await page.waitForSelector('#boot-entry[data-phase="login"]');
        check(
          `${label}: escape returns to login`,
          (await page.textContent("#entry-title"))?.trim() === "WELCOME",
        );
        // Decorations must not capture pointer events over the controls.
        const pointerEvents = await page.evaluate(() => [
          getComputedStyle(document.querySelector(".intro-brand"))
            .pointerEvents,
          getComputedStyle(document.querySelector(".intro-powered"))
            .pointerEvents,
        ]);
        check(
          `${label}: decorations ignore pointer events`,
          pointerEvents.every((v) => v === "none"),
          pointerEvents.join(","),
        );
        await page.locator("#entry-submit").click({ timeout: 10000 });
        await page.waitForSelector("#boot-entry.has-error", { timeout: 5000 });
        check(`${label}: LOGIN is clickable through the overlay`, true);
        await page.screenshot({
          path: `${outDir}/mobile-${label}.png`,
          animations: "disabled",
        });
        await context.close();
      }
    } else if (scenario === "query-boundary") {
      // The production bundle must ignore review/debug query parameters.
      for (const query of [
        "?review=1",
        "?time=3",
        "?freeze=1",
        "?entryMock=success",
      ]) {
        const page = await gotoPage(
          browser,
          { width: 1280, height: 800 },
          query,
        );
        const state = await page.evaluate(() => ({
          identity: window.rhine?.stats?.().identity?.kind,
          intro: window.rhine?.stats?.().introPhase,
          review: document.querySelector("#stage")?.dataset.review ?? null,
          seek: typeof window.rhine?.seek,
          preview: typeof window.rhine?.playBootPreview,
        }));
        check(
          `${query}: intro still requires a real choice`,
          state.intro === "ready" && state.identity === "none",
          JSON.stringify(state),
        );
        check(`${query}: no review mode on the stage`, state.review === null);
        check(
          `${query}: active seek controls absent`,
          state.seek === "undefined" && state.preview === "undefined",
          JSON.stringify(state),
        );
        await page.close();
      }
    } else {
      // guest / reduced: DOM anti-bleed + handoff + phase screenshots.
      const page = await browser.newPage({
        viewport: { width: 1920, height: 1080 },
        reducedMotion: reduced,
      });
      page.on("pageerror", (error) =>
        console.error("pageerror:", error.message),
      );
      await page.addInitScript(() => {
        window.__introTrace = [];
        const sample = () => {
          const stage = document.querySelector("#stage");
          const intro = document.querySelector("#boot-intro");
          if (stage && intro && window.__introTrace.length < 6000) {
            const opacity = (selector) => {
              const el = document.querySelector(selector);
              return el ? getComputedStyle(el).opacity : null;
            };
            const logo = document.querySelector("#intro-logo");
            const rect = logo?.getBoundingClientRect();
            window.__introTrace.push({
              introPhase: intro.dataset.introPhase,
              stageVisibility: getComputedStyle(stage).visibility,
              boot: stage.dataset.boot,
              bootFrame: stage.dataset.bootFrame,
              brandLine: opacity(".brand h1"),
              powered: opacity(".powered"),
              introLogos: document.querySelectorAll("#intro-logo").length,
              logoLeft: rect ? Math.round(rect.left) : null,
            });
          }
          requestAnimationFrame(sample);
        };
        requestAnimationFrame(sample);
      });
      await page.goto(base, { waitUntil: "domcontentloaded" });
      await page.waitForFunction(
        () => window.rhine?.stats()?.introPhase === "ready",
        null,
        { timeout: 60000 },
      );
      await page.waitForSelector('#boot-entry[data-phase="login"]', {
        timeout: 15000,
      });
      const readyStats = await page.evaluate(() => window.rhine.stats());
      check("intro reaches ready", readyStats.introPhase === "ready");
      check(
        "stage hidden while intro ready",
        readyStats.stageVisibility === "hidden",
      );
      check("single intro logo node", readyStats.introLogos === 1);
      await page.screenshot({
        path: `${outDir}/${scenario}-ready.png`,
        animations: "disabled",
      });

      await page.locator('[data-entry="guest"]').dispatchEvent("click");
      if (scenario === "reduced") {
        let entered = false;
        for (let i = 0; i < 60 && !entered; i++) {
          await page.waitForTimeout(250);
          entered =
            (await page.evaluate(() => window.rhine?.stats?.().introPhase)) ===
            "entered";
        }
        if (!entered) throw new Error("reduced commit never reached entered");
      } else {
        // Capture the exit/handoff window; software rendering may skip frames.
        const shots = [];
        for (let i = 0; i < 6; i++) {
          const file = `${outDir}/handoff-${String(i).padStart(2, "0")}.png`;
          await page
            .screenshot({ path: file, animations: "allow" })
            .catch(() => {});
          shots.push(file);
          await page.waitForTimeout(40);
        }
        await page.waitForFunction(
          () =>
            Number(document.querySelector("#stage")?.dataset.bootFrame) >= 187,
          null,
          { timeout: 20000, polling: 50 },
        );
      }

      const rows = await page.evaluate(() => window.__introTrace);
      const firstVisibleIndex = rows.findIndex(
        (r) => r.stageVisibility === "visible",
      );
      check(
        "single intro logo node throughout",
        rows.every((r) => r.introLogos === 1),
      );
      check(
        "stage never visible while the intro covers it",
        rows.every(
          (r) =>
            !["connecting", "docking", "ready", "exiting"].includes(
              r.introPhase,
            ) || r.stageVisibility === "hidden",
        ),
      );
      const firstVisible = rows[firstVisibleIndex];
      check(
        "first visible original frame is 169",
        firstVisible?.bootFrame === "169",
        JSON.stringify(firstVisible),
      );
      const transitions = rows.filter(
        (r, i) => i > 0 && rows[i - 1].stageVisibility !== r.stageVisibility,
      );
      check(
        "handoff commits exactly once",
        transitions.filter((r) => r.stageVisibility === "visible").length === 1,
      );
      if (scenario !== "reduced") {
        check(
          "stage brand is not exposed at the handoff",
          (firstVisible?.brandLine ?? "1") === "0" &&
            (firstVisible?.powered ?? "1") === "0",
          JSON.stringify({
            brand: firstVisible?.brandLine,
            powered: firstVisible?.powered,
          }),
        );
        const lefts = rows
          .filter((r) => r.introPhase === "docking")
          .map((r) => r.logoLeft)
          .filter((v) => v !== null);
        check(
          "logo docks continuously to the left",
          lefts.length > 2 && lefts[0] > lefts.at(-1),
          `first=${lefts[0]} last=${lefts.at(-1)}`,
        );
      }
      await page.close();
    }
  } finally {
    await browser.close();
  }
} finally {
  preview?.kill();
}

const failed = checks.filter((c) => !c.ok);
const report = {
  scenario,
  browser: browserName,
  passed: checks.length - failed.length,
  total: checks.length,
  checks,
};
writeFileSync(
  `${outDir}/report-${scenario}.json`,
  `${JSON.stringify(report, null, 2)}\n`,
);
for (const c of checks)
  console.log(
    `${c.ok ? "ok  " : "FAIL"} ${c.name}${c.detail && !c.ok ? ` — ${c.detail}` : ""}`,
  );
console.log(
  `\n${report.passed}/${report.total} checks passed (scenario=${scenario})`,
);
process.exit(failed.length ? 1 : 0);
