const PORT = Number(process.env.CDP_PORT ?? 9333);

async function pageSocketUrl() {
  const response = await fetch(`http://127.0.0.1:${PORT}/json/list`);
  const targets = await response.json();
  const page = targets.find((target) => target.type === "page");
  if (!page)
    throw new Error("no Slack page target — is Slack running with --remote-debugging-port?");
  return page.webSocketDebuggerUrl;
}

class Session {
  #socket;
  #nextId = 1;
  #pending = new Map();

  static async open() {
    const session = new Session();
    session.#socket = new WebSocket(await pageSocketUrl());
    await new Promise((resolve, reject) => {
      session.#socket.addEventListener("open", resolve, { once: true });
      session.#socket.addEventListener("error", reject, { once: true });
    });
    session.#socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      const waiter = session.#pending.get(message.id);
      if (!waiter) return;
      session.#pending.delete(message.id);
      if (message.error) waiter.reject(new Error(JSON.stringify(message.error)));
      else waiter.resolve(message.result);
    });
    return session;
  }

  send(method, params = {}) {
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`CDP timeout: ${method}`)), 15_000);
      this.#pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      });
      this.#socket.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression) {
    const result = await this.send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description ?? "evaluation threw");
    }
    return result.result?.value;
  }

  close() {
    this.#socket.close();
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const CLICK = (selector) => `(() => {
  const start = document.querySelector(${JSON.stringify(selector)});
  if (!start) return "NOT FOUND: " + ${JSON.stringify(selector)};
  let node = start;
  while (node && typeof node.click !== "function") node = node.parentElement;
  if (!node) return "NO CLICKABLE ANCESTOR: " + ${JSON.stringify(selector)};
  node.click();
  return "clicked: " + (node.getAttribute("aria-label") || node.textContent || "").trim().slice(0, 60);
})()`;

async function sendMessage(session, text) {
  const expected = process.env.CDP_EXPECT_CONVERSATION;
  if (!expected) {
    throw new Error("refusing to send: set CDP_EXPECT_CONVERSATION to the target conversation id");
  }
  const url = await session.evaluate("location.href");
  if (!url.includes(expected)) {
    throw new Error(`refusing to send: expected ${expected}, but Slack is showing ${url}`);
  }

  const focused = await session.evaluate(`(() => {
    const editors = [...document.querySelectorAll(".ql-editor[contenteditable=true]")]
      .filter((el) => el.offsetParent !== null);
    if (!editors.length) return "no composer";
    const channel = editors.find((el) => !el.closest("[data-qa=reply_container]"));
    if (!channel) return "thread-only";
    channel.focus();
    return "focused";
  })()`);
  if (focused === "no composer") throw new Error("no composer");
  if (focused === "thread-only") {
    throw new Error(
      "refusing to send: the only visible composer belongs to a thread — close the thread " +
        "pane first, or the message goes into the thread instead of the channel",
    );
  }

  const existing = await session.evaluate(`(document.activeElement?.textContent ?? "").length`);
  for (let index = 0; index < existing; index++) {
    for (const type of ["keyDown", "keyUp"]) {
      await session.send("Input.dispatchKeyEvent", {
        type,
        key: "Backspace",
        code: "Backspace",
        windowsVirtualKeyCode: 8,
        nativeVirtualKeyCode: 8,
      });
    }
  }
  await sleep(200);

  await session.send("Input.insertText", { text });
  await sleep(400);

  if (text.startsWith("/")) {
    for (const type of ["keyDown", "keyUp"]) {
      await session.send("Input.dispatchKeyEvent", {
        type,
        key: "Escape",
        code: "Escape",
        windowsVirtualKeyCode: 27,
        nativeVirtualKeyCode: 27,
      });
    }
    await sleep(250);
  }

  const pressEnter = async () => {
    for (const type of ["keyDown", "keyUp"]) {
      await session.send("Input.dispatchKeyEvent", {
        type,
        windowsVirtualKeyCode: 13,
        nativeVirtualKeyCode: 13,
        key: "Enter",
        code: "Enter",
        text: type === "keyDown" ? "\r" : undefined,
      });
    }
    await sleep(600);
    return session.evaluate(`(document.activeElement?.textContent ?? "").trim()`);
  };

  let leftover = await pressEnter();
  if (leftover !== "") leftover = await pressEnter();

  return leftover === "" ? "sent" : `composer still holds: ${leftover.slice(0, 80)}`;
}

const [, , command, argument] = process.argv;
const session = await Session.open();

try {
  let value;
  if (command === "send") {
    value = await sendMessage(session, argument);
  } else if (command === "eval") {
    value = await session.evaluate(argument);
  } else if (command === "clickat") {
    const box = await session.evaluate(`(() => {
      const match = [...document.querySelectorAll("button,[role=button],a")]
        .find((el) => (el.textContent || "").trim() === ${JSON.stringify(argument)});
      if (!match) return null;
      const rect = match.getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    })()`);
    if (!box) throw new Error(`no element with exact text: ${argument}`);
    for (const type of ["mousePressed", "mouseReleased"]) {
      await session.send("Input.dispatchMouseEvent", {
        type,
        x: box.x,
        y: box.y,
        button: "left",
        clickCount: 1,
      });
    }
    await sleep(800);
    value = `clicked "${argument}" at ${Math.round(box.x)},${Math.round(box.y)}`;
  } else if (command === "type") {
    await session.evaluate(
      `document.querySelector(".ql-editor[contenteditable=true]")?.focus(), "ok"`,
    );
    const existing = await session.evaluate(`(document.activeElement?.textContent ?? "").length`);
    for (let index = 0; index < existing; index++) {
      for (const type of ["keyDown", "keyUp"]) {
        await session.send("Input.dispatchKeyEvent", {
          type,
          key: "Backspace",
          code: "Backspace",
          windowsVirtualKeyCode: 8,
          nativeVirtualKeyCode: 8,
        });
      }
    }
    await session.send("Input.insertText", { text: argument });
    await sleep(700);
    value = await session.evaluate(`(() => {
      const composer = document.querySelector(".ql-editor[contenteditable=true]");
      const visible = [...document.querySelectorAll("[role=listbox],[role=option],[class*=suggestion],[class*=autocomplete]")]
        .filter((el) => el.offsetParent !== null)
        .slice(0, 5)
        .map((el) => (el.textContent || "").trim().slice(0, 120));
      return { composer: composer?.textContent ?? "", menu: visible };
    })()`);
  } else if (command === "press") {
    const keys = {
      Enter: [13, "\r"],
      Escape: [27, undefined],
      Backspace: [8, undefined],
      Tab: [9, undefined],
    };
    const [code, printable] = keys[argument] ?? [];
    if (!code) throw new Error(`unknown key: ${argument}`);
    await session.evaluate(
      `document.querySelector(".ql-editor[contenteditable=true]")?.focus(), "ok"`,
    );
    for (const type of ["keyDown", "keyUp"]) {
      await session.send("Input.dispatchKeyEvent", {
        type,
        key: argument,
        code: argument,
        windowsVirtualKeyCode: code,
        nativeVirtualKeyCode: code,
        ...(type === "keyDown" && printable ? { text: printable } : {}),
      });
    }
    await sleep(600);
    value = `pressed ${argument}; composer now: ${JSON.stringify(
      await session.evaluate(
        `(document.querySelector(".ql-editor[contenteditable=true]")?.textContent ?? "")`,
      ),
    )}`;
  } else if (command === "click") {
    value = await session.evaluate(CLICK(argument));
  } else if (command === "text") {
    value = await session.evaluate(`(() => {
      const els = [...document.querySelectorAll(${JSON.stringify(argument)})];
      if (!els.length) return "NOT FOUND: " + ${JSON.stringify(argument)};
      return els.map((el) => (el.textContent || "").trim()).filter(Boolean).slice(0, 40).join("\\n");
    })()`);
  } else {
    console.error("usage: node cdp.mjs <eval|click|text|send> <argument>");
    process.exit(1);
  }
  console.log(typeof value === "string" ? value : JSON.stringify(value, null, 2));
} catch (err) {
  console.error(`CDP error: ${err.message}`);
  process.exitCode = 1;
} finally {
  session.close();
}
