// L1c browser checks for the 图三 login/register panel. Starts the lab dev
// server with a DEV-only mock port (?entryMock=...) and drives headless
// Chromium. The register mock only exercises the UI; it is not real
// registration evidence (that is L3a/L3b). Screenshots + JSON report under
// .tools/login-improve/L1c/.
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createServer } from "vite";
import { chromium } from "playwright";

const outDir = resolve(".tools/login-improve/L1c");
mkdirSync(outDir, { recursive: true });
const checks = [];
const check = (name, condition, detail = "") => {
  checks.push({ name, passed: Boolean(condition), detail });
  if (!condition) console.error(`FAIL ${name} ${detail}`);
};

const server = await createServer({
  configFile: resolve("vite.lab.config.ts"),
  server: { host: "127.0.0.1", port: 5177, strictPort: true },
});
await server.listen();
const base = server.resolvedUrls.local[0].replace(/\/$/, "");
console.log("dev server:", base);

const browser = await chromium.launch({
  args: [
    "--no-sandbox",
    "--use-gl=angle",
    "--use-angle=swiftshader",
    "--enable-unsafe-swiftshader",
  ],
});

async function bootGate(context, query) {
  const page = await context.newPage();
  page.setDefaultNavigationTimeout(90000);
  page.on("pageerror", (error) => console.error("pageerror:", error.message));
  await page.goto(`${base}/?${query}`, { waitUntil: "domcontentloaded" });
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

async function waitForCommit(page) {
  await page.waitForFunction(
    () => ["playing", "entered"].includes(window.rhine?.stats()?.introPhase),
    null,
    { timeout: 15000 },
  );
}

async function watchBootFrames(page) {
  await page.evaluate(() => {
    window.__bootFrames = [];
    const el = document.querySelector("#stage");
    const observer = new MutationObserver(() => {
      const value = el.dataset.bootFrame;
      if (value && window.__bootFrames.length < 40)
        window.__bootFrames.push(Number(value));
    });
    observer.observe(el, {
      attributes: true,
      attributeFilter: ["data-boot-frame"],
    });
  });
}

try {
  const desktop = await browser.newContext({
    viewport: { width: 1920, height: 1080 },
  });
  const page = await bootGate(desktop, "entryMock=success");

  // 1. 图三 organization and no auto-focus.
  check(
    "WELCOME title",
    (await page.textContent("#entry-title"))?.trim() === "WELCOME",
  );
  check(
    "username label",
    (
      await page.textContent(
        "#boot-entry .entry-field:nth-of-type(1) .entry-label",
      )
    )?.trim() === "USERNAME:",
  );
  check(
    "password label",
    (
      await page.textContent(
        "#boot-entry .entry-field:nth-of-type(2) .entry-label",
      )
    )?.trim() === "PASSWORD:",
  );
  check(
    "LOGIN submit",
    (await page.textContent("#entry-submit"))?.trim() === "LOGIN",
  );
  check(
    "REGISTER link",
    (await page.textContent('[data-entry="register"]'))?.trim() === "REGISTER",
  );
  check(
    "guest link",
    (await page.textContent('[data-entry="guest"]'))?.trim() ===
      "ENTER AS GUEST",
  );
  check(
    "old REGISTERED USER choice removed",
    (await page.$('[data-entry="registered"]')) === null,
  );
  check("intro logo present", await page.isVisible("#intro-logo"));
  check(
    "intro brand visible",
    (await page.$eval(".intro-brand", (el) => getComputedStyle(el).opacity)) ===
      "1",
  );
  check(
    "intro powered visible",
    (await page.$eval(
      ".intro-powered",
      (el) => getComputedStyle(el).opacity,
    )) === "1",
  );
  check(
    "stage hidden behind intro",
    (await page.$eval("#stage", (el) => getComputedStyle(el).visibility)) ===
      "hidden",
  );
  check(
    "stage inert behind intro",
    await page.$eval("#stage", (el) => el.inert),
  );
  check(
    "no auto-focus on entry",
    await page.evaluate(
      () =>
        !["entry-username", "entry-password"].includes(
          document.activeElement?.id ?? "",
        ),
    ),
  );
  await page.screenshot({
    path: `${outDir}/login-desktop.png`,
    animations: "disabled",
  });

  // 2. REGISTER switches in place without moving the Logo.
  const logoBefore = await page.locator("#intro-logo").boundingBox();
  await page.click('[data-entry="register"]');
  await page.waitForSelector('#boot-entry[data-phase="register"]');
  const logoAfter = await page.locator("#intro-logo").boundingBox();
  check(
    "logo does not move when switching panels",
    logoBefore &&
      logoAfter &&
      Math.abs(logoBefore.x - logoAfter.x) < 0.5 &&
      Math.abs(logoBefore.y - logoAfter.y) < 0.5,
    JSON.stringify({ logoBefore, logoAfter }),
  );
  check(
    "register title",
    (await page.textContent("#entry-title"))?.trim() === "REGISTER",
  );
  check("confirm field visible", await page.isVisible("#entry-confirm"));
  check(
    "submit says REGISTER",
    (await page.textContent("#entry-submit"))?.trim() === "REGISTER",
  );
  check("BACK TO LOGIN visible", await page.isVisible("#entry-back"));
  check(
    "REGISTER link hidden in register mode",
    !(await page.isVisible('[data-entry="register"]')),
  );
  await page.screenshot({
    path: `${outDir}/register-desktop.png`,
    animations: "disabled",
  });
  await page.keyboard.press("Escape");
  await page.waitForSelector('#boot-entry[data-phase="login"]');
  check(
    "escape returns to login",
    (await page.textContent("#entry-title"))?.trim() === "WELCOME",
  );

  // 3. Validation keeps username, clears password, shows the reserved error line.
  await page.fill("#entry-username", "JOYCE_MOORE");
  await page.fill("#entry-password", "short");
  await page.click("#entry-submit");
  await page.waitForSelector("#boot-entry.has-error");
  check(
    "invalid password keeps username",
    (await page.inputValue("#entry-username")) === "JOYCE_MOORE",
  );
  check(
    "invalid password clears password",
    (await page.inputValue("#entry-password")) === "",
  );
  check(
    "error line announced",
    ((await page.textContent("#entry-error")) ?? "").length > 0,
  );

  // 4. Input isolation: "/" and Escape must not reach the archive.
  await page.fill("#entry-password", "a/very long password");
  await page.keyboard.press("/");
  check(
    "slash does not open search",
    (await page.$("#archive-search")) === null,
  );
  await page.keyboard.press("Escape");
  check(
    "escape stays on boot",
    (await page.getAttribute("#stage", "data-mode")) === "boot",
  );

  // 5. Successful login through the DEV port.
  await page.click("#entry-submit");
  await waitForCommit(page);
  const stats = await page.evaluate(() => window.rhine.stats());
  check(
    "registered identity committed",
    stats.identity?.kind === "registered",
    JSON.stringify(stats.identity),
  );
  check(
    "identity label uppercased",
    stats.identity?.label === "JOYCEMOORE",
    stats.identity?.label,
  );
  check(
    "footer shows registered label",
    (await page.textContent("#session-identity"))?.trim() === "JOYCEMOORE",
  );
  check(
    "stage no longer inert",
    !(await page.$eval("#stage", (el) => el.inert)),
  );
  await page.close();

  // 6. Register creates no identity; success returns to login with username kept.
  const reg = await bootGate(desktop, "entryMock=success");
  await reg.click('[data-entry="register"]');
  await reg.fill("#entry-username", "NewUser01");
  await reg.fill("#entry-password", "a very long password");
  await reg.fill("#entry-confirm", "mismatch password");
  await reg.click("#entry-submit");
  await reg.waitForSelector("#boot-entry.has-error");
  check(
    "mismatched confirm rejected",
    /不一致/.test((await reg.textContent("#entry-error")) ?? ""),
  );
  await reg.fill("#entry-confirm", "a very long password");
  await reg.click("#entry-submit");
  await reg.waitForSelector("#boot-entry.has-success");
  check(
    "register success returns to login",
    (await reg.getAttribute("#boot-entry", "data-phase")) === "login",
  );
  check(
    "register success keeps username",
    (await reg.inputValue("#entry-username")) === "NewUser01",
  );
  check(
    "register success clears passwords",
    (await reg.inputValue("#entry-password")) === "" &&
      (await reg.inputValue("#entry-confirm")) === "",
  );
  check(
    "register success message names the user",
    /NewUser01/.test((await reg.textContent("#entry-error")) ?? ""),
  );
  await reg.waitForTimeout(400);
  check(
    "register never commits an identity",
    (await reg.evaluate(() => window.rhine.stats().introPhase)) === "ready",
  );
  check(
    "identity still none after register",
    (await reg.evaluate(() => window.rhine.stats().identity.kind)) === "none",
  );
  await reg.close();

  // 7. Register failure and disabled modes stay on the register page.
  const regFail = await bootGate(desktop, "entryMock=register-fail");
  await regFail.click('[data-entry="register"]');
  await regFail.fill("#entry-username", "taken");
  await regFail.fill("#entry-password", "a very long password");
  await regFail.fill("#entry-confirm", "a very long password");
  await regFail.click("#entry-submit");
  await regFail.waitForSelector("#boot-entry.has-error");
  check(
    "register failure message",
    /不可用/.test((await regFail.textContent("#entry-error")) ?? ""),
  );
  check(
    "register failure stays on register",
    (await regFail.getAttribute("#boot-entry", "data-phase")) === "register",
  );
  await regFail.close();

  const regOff = await bootGate(desktop, "entryMock=register-disabled");
  await regOff.click('[data-entry="register"]');
  await regOff.fill("#entry-username", "NewUser02");
  await regOff.fill("#entry-password", "a very long password");
  await regOff.fill("#entry-confirm", "a very long password");
  await regOff.click("#entry-submit");
  await regOff.waitForSelector("#boot-entry.has-error");
  check(
    "register disabled message",
    /暂未开放/.test((await regOff.textContent("#entry-error")) ?? ""),
  );
  await regOff.close();

  // 8. Escape cancels an in-flight login; GUEST still commits afterwards.
  const slow = await bootGate(desktop, "entryMock=timeout");
  await slow.fill("#entry-username", "JOYCE_MOORE");
  await slow.fill("#entry-password", "a very long password");
  await slow.click("#entry-submit");
  await slow.waitForSelector("#boot-entry[data-busy]", { timeout: 5000 });
  await slow.focus("#entry-submit");
  await slow.keyboard.press("Escape");
  await slow.waitForFunction(
    () => !document.querySelector("#boot-entry")?.hasAttribute("data-busy"),
    null,
    { timeout: 5000 },
  );
  check(
    "escape clears the busy state",
    !(await slow.$eval("#boot-entry", (el) => el.hasAttribute("data-busy"))),
  );
  await slow.click('[data-entry="guest"]');
  await waitForCommit(slow);
  check(
    "guest commits after a cancelled attempt",
    (await slow.evaluate(() => window.rhine.stats().identity.kind)) === "guest",
  );
  await slow.close();

  // 9. GUEST commits at the white frame after any wait.
  const guest = await bootGate(desktop, "entryMock=success");
  await watchBootFrames(guest);
  await guest.click('[data-entry="guest"]');
  await waitForCommit(guest);
  const frames = await guest.evaluate(() => window.__bootFrames ?? []);
  check(
    "guest identity committed",
    (await guest.evaluate(() => window.rhine.stats().identity.kind)) ===
      "guest",
  );
  check(
    "boot begins at frame 169",
    frames.includes(169) && Math.min(...frames) <= 187,
    JSON.stringify(frames.slice(0, 8)),
  );
  await guest.close();

  await desktop.close();

  // 10. Mobile: stack layout, legible inputs, all actions reachable.
  const mobile = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  const mpage = await bootGate(mobile, "entryMock=success");
  const logoBox = await mpage.locator("#intro-logo").boundingBox();
  const formBox = await mpage.locator("#boot-entry").boundingBox();
  check(
    "mobile layout stacks logo above panel",
    Boolean(logoBox && formBox && formBox.y >= logoBox.y + logoBox.height),
    JSON.stringify({ logoBox, formBox }),
  );
  const inputFont = await mpage.$eval("#entry-username", (el) =>
    parseFloat(getComputedStyle(el).fontSize),
  );
  check("mobile input >= 16px", inputFont >= 16, String(inputFont));
  check("mobile LOGIN reachable", await mpage.isVisible("#entry-submit"));
  check(
    "mobile REGISTER reachable",
    await mpage.isVisible('[data-entry="register"]'),
  );
  check(
    "mobile GUEST reachable",
    await mpage.isVisible('[data-entry="guest"]'),
  );
  check(
    "mobile no horizontal scroll",
    await mpage.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth + 1,
    ),
  );
  await mpage.screenshot({
    path: `${outDir}/login-mobile.png`,
    animations: "disabled",
  });
  await mpage.click('[data-entry="register"]');
  await mpage.waitForSelector('#boot-entry[data-phase="register"]');
  check(
    "mobile confirm field reachable",
    await mpage.isVisible("#entry-confirm"),
  );
  await mpage.screenshot({
    path: `${outDir}/register-mobile.png`,
    animations: "disabled",
  });
  await mobile.close();
} finally {
  await browser.close();
  await server.close();
}

const passed = checks.filter((c) => c.passed).length;
const report = { passed, failed: checks.length - passed, checks };
writeFileSync(`${outDir}/report.json`, `${JSON.stringify(report, null, 2)}\n`);
console.log(`L1c browser checks: ${passed}/${checks.length} passed`);
if (passed !== checks.length) process.exit(1);
