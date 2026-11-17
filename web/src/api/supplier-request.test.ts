import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, DEFAULT_TIMEOUT_MS } from "./client";
import { supplierRequestApi } from "./supplier-request";

// #17 O fio do pedido ao fornecedor: caminhos por chave de acesso, o corpo de cada ação e o que a tela recebe.

const KEY = "35261100000000000000550010000200461000200461";
const BASE = `/api/supplier-requests/${KEY}`;
const writing = { status: "writing" } as const;

let calls: { method: string; path: string; body: unknown }[] = [];

function serve(response: () => Response): void {
  calls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      calls.push({ method: init.method ?? "GET", path: String(input), body: init.body ? JSON.parse(String(init.body)) : undefined });
      return response();
    }),
  );
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("#17 porta do pedido ao fornecedor sobre a API", () => {
  it("#17/AC-1: load lê o pedido pela chave de acesso e devolve o que está em `request`", async () => {
    serve(() => Response.json({ request: writing }));
    expect(await supplierRequestApi.load(KEY, new AbortController().signal)).toEqual(writing);
    expect(calls).toEqual([{ method: "GET", path: BASE, body: undefined }]);
  });

  it("#17/AC-1: sem pedido a API devolve request nulo, e a porta devolve nulo", async () => {
    serve(() => Response.json({ request: null }));
    expect(await supplierRequestApi.load(KEY, new AbortController().signal)).toBeNull();
  });

  it("#17/AC-1: 404 na leitura é sem pedido; outro erro continua erro", async () => {
    serve(() => Response.json({ error: "not_found" }, { status: 404 }));
    expect(await supplierRequestApi.load(KEY, new AbortController().signal)).toBeNull();
    serve(() => Response.json({ error: "internal_error" }, { status: 500 }));
    await expect(supplierRequestApi.load(KEY, new AbortController().signal)).rejects.toBeInstanceOf(ApiError);
  });

  it("#17/AC-4 e AC-5: send, resend, discard e redo são POST com corpo vazio e devolvem o pedido", async () => {
    for (const action of ["send", "resend", "discard", "redo"] as const) {
      serve(() => Response.json({ request: writing }));
      expect(await supplierRequestApi[action](KEY)).toEqual(writing);
      expect(calls).toEqual([{ method: "POST", path: `${BASE}/${action}`, body: {} }]);
    }
  });

  it("#17/AC-6: saveTemplate é PATCH com o molde em `template`", async () => {
    serve(() => Response.json({ request: writing }));
    await supplierRequestApi.saveTemplate(KEY, "Na NF {{numero}} veio {{item}}.");
    expect(calls).toEqual([{ method: "PATCH", path: BASE, body: { template: "Na NF {{numero}} veio {{item}}." } }]);
  });

  it("#17/AC-6: 422 do PATCH chega como ApiError, para a tela mostrar a mensagem fixa", async () => {
    serve(() => Response.json({ error: "invalid", reason: "number_mismatch", field: "body" }, { status: 422 }));
    const error = await supplierRequestApi.saveTemplate(KEY, "Valor 99").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(422);
  });

  it("#17/AC-4: a ação que nunca responde termina em falha no prazo (REL-1)", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_path: string, init: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init.signal?.addEventListener("abort", () => reject(init.signal?.reason));
          }),
      ),
    );
    const outcome = supplierRequestApi.send(KEY).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(DEFAULT_TIMEOUT_MS);
    expect(await outcome).toBeInstanceOf(ApiError);
  });
});
