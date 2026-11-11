import type { KernelEngine, KernelExecution, KernelIO, KernelRequest, KernelResponse, KernelValue, RunResult } from "../types";

/**
 * Answers the kernel client's requests one at a time. The engine and its file system stay alive between requests;
 * only per-command I/O is replaced. `create` gets the first request, with any fields the host's transport added.
 */
export function serveKernel<E extends KernelExecution = KernelExecution, R extends RunResult = RunResult>(
  create: (initial: KernelRequest<E> & Record<string, unknown>) => KernelEngine<E, R> | Promise<KernelEngine<E, R>>,
): void {
  const post = self.postMessage.bind(self);
  let engine: Promise<KernelEngine<E, R>> | undefined;
  let queue = Promise.resolve();
  let lastId = 0;
  const send = (response: KernelResponse<R>) => post(response);
  self.onmessage = (event: MessageEvent<KernelRequest<E> & Record<string, unknown>>) => {
    const request = event.data;
    if (!Number.isSafeInteger(request?.id) || request.id <= lastId) return;
    lastId = request.id;
    queue = queue.then(async () => {
      const id = request.id;
      try {
        engine ??= Promise.resolve().then(() => create(request));
        let instance: KernelEngine<E, R>;
        try {
          instance = await engine;
        } catch (error) {
          send({ id, type: "error", error: error instanceof Error ? error.message : String(error), fatal: true });
          return;
        }
        const io: KernelIO = {
          status: (status) => send({ id, type: "status", status }),
          input: (message) => send({ ...message, id }),
        };
        let value: KernelValue<R>;
        switch (request.op) {
          case "execute":
            value = await instance.execute(request.source, request.options, io);
            break;
          case "listFiles":
            value = await instance.listFiles();
            break;
          case "readFile":
            value = await instance.readFile(request.name);
            break;
          case "writeFile":
            value = await instance.writeFile(request.name, request.data);
            break;
          case "removeFile":
            value = await instance.removeFile(request.name);
            break;
        }
        // clone, never transfer: the bytes may be the interpreter's own retained storage
        send({ id, type: "result", value });
      } catch (error) {
        send({ id, type: "error", error: error instanceof Error ? error.message : String(error) });
      }
    });
  };
}
