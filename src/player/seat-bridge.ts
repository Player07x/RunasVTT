/**
 * Shim mínimo da ponte RunasVTT para a origem efêmera do Runas Tools servido
 * pelo PlayerServer. Ele usa HTTP para o envelope (que pode ter megabytes) e
 * WebSocket somente para avisos curtos de mudança.
 *
 * O primeiro bloco repõe `crypto.randomUUID`. O assento vive em
 * `http://IP:porta`, que não é contexto seguro, e o navegador esconde
 * `randomUUID` fora de contexto seguro — só `127.0.0.1` escapa, que é
 * justamente a janela local do mestre. O Runas Tools chama `randomUUID` ao
 * importar, salvar e criar fichas, e este shim o chama no `mutationId`: sem a
 * reposição, o jogador da rede local recebe "crypto.randomUUID is not a
 * function". `getRandomValues` continua disponível e dá a mesma aleatoriedade.
 *
 * Por isso o `PlayerServer` injeta este script no começo do `<head>`: ele
 * precisa rodar antes de qualquer código do Tools.
 */
export const SEAT_BRIDGE_SCRIPT = String.raw`(() => {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID !== "function" && typeof crypto.getRandomValues === "function") {
    const byteToHex = [];
    for (let index = 0; index < 256; index += 1) byteToHex.push((index + 0x100).toString(16).slice(1));
    const randomUUID = function randomUUID() {
      const bytes = crypto.getRandomValues(new Uint8Array(16));
      // Versão 4 e variante RFC 4122, como manda a especificação.
      bytes[6] = (bytes[6] & 0x0f) | 0x40;
      bytes[8] = (bytes[8] & 0x3f) | 0x80;
      let text = "";
      for (let index = 0; index < 16; index += 1) {
        if (index === 4 || index === 6 || index === 8 || index === 10) text += "-";
        text += byteToHex[bytes[index]];
      }
      return text;
    };
    try {
      Object.defineProperty(crypto, "randomUUID", { value: randomUUID, configurable: true, writable: true });
    } catch (_) {
      crypto.randomUUID = randomUUID;
    }
  }
})();

(() => {
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
