/**
 * Shim mínimo da ponte RunasVTT para a origem efêmera do Runas Tools servido
 * pelo PlayerServer. Ele usa HTTP para o envelope (que pode ter megabytes) e
 * WebSocket somente para avisos curtos de mudança.
 */
export const SEAT_BRIDGE_SCRIPT = String.raw`(() => {
  const protocol = 1;
  const key = new URLSearchParams(location.search).get("k") || "";
  const listeners = new Set();
  let revision = 0;
  let socket = null;
  let poll = null;

  function url(path) {
    const separator = path.includes("?") ? "&" : "?";
    return path + separator + "k=" + encodeURIComponent(key);
  }

  async function request(path, init) {
    const response = await fetch(url(path), Object.assign({ credentials: "same-origin", cache: "no-store" }, init || {}));
    let body = null;
    try { body = await response.json(); } catch (_) { /* resposta sem corpo */ }
    if (!response.ok) {
      const error = new Error(body && body.error ? body.error : "Não foi possível comunicar com a mesa.");
      error.status = response.status;
      error.body = body;
      throw error;
    }
    return body;
  }

  async function readCharacter() {
    const body = await request("/seat/character");
    const character = body && body.character ? body.character : null;
    if (character && typeof character.revision === "number") revision = character.revision;
    return character;
  }

  function notify() { listeners.forEach((listener) => { try { listener(); } catch (_) {} }); }

  function connect() {
    if (socket || !key) return;
    const scheme = location.protocol === "https:" ? "wss:" : "ws:";
    socket = new WebSocket(scheme + "//" + location.host + "/socket?k=" + encodeURIComponent(key));
    socket.onmessage = (event) => {
      try {
        const message = JSON.parse(String(event.data));
        if (message.type === "character-changed" && typeof message.revision === "number") {
          revision = message.revision;
          notify();
        }
      } catch (_) { /* mensagens da projeção não pertencem ao shim */ }
    };
    socket.onclose = () => { socket = null; };
  }

  async function save(character, tokenId) {
    const body = await request("/seat/character", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ character, tokenId: tokenId || null, baseRevision: revision, mutationId: crypto.randomUUID() })
    });
    if (body && body.character && typeof body.character.revision === "number") revision = body.character.revision;
    notify();
    return body;
  }

  window.runasVTT = {
    protocol,
    scope: "seat",
    importCharacters: async (items) => {
      if (!Array.isArray(items) || items.length !== 1) throw new Error("O assento aceita uma ficha por vez.");
      const body = await save(items[0], null);
      return { tokenIds: body && body.character && body.character.tokenId ? [body.character.tokenId] : [] };
    },
    getTokens: async () => {
      const character = await readCharacter();
      if (!character || !character.tokenId) return [];
      return [{ id: character.tokenId, sceneId: character.sceneId || "", name: character.summary.name, selected: false, source: "tools", envelope: character.envelope, summary: character.summary }];
    },
    onTokensChanged: (listener) => {
      listeners.add(listener);
      connect();
      if (!poll) poll = setInterval(() => { void readCharacter().then(() => notify()).catch(() => undefined); }, 2500);
      return () => {
        listeners.delete(listener);
        if (!listeners.size && poll) { clearInterval(poll); poll = null; }
      };
    },
    updateTokenCharacter: async (tokenId, envelope, summary) => { await save({ envelope, summary, source: "tools", tokenImage: null, tokenSize: 1 }, tokenId); },
    postLog: async () => undefined
  };
})();`;
