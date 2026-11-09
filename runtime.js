import { ConsoleStdout, File, OpenFile, WASI } from "./wasi/index.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export async function instantiate(source) {
  const wasi = new WASI([], [], [
    new OpenFile(new File([])),
    ConsoleStdout.lineBuffered(console.log),
    ConsoleStdout.lineBuffered(console.error),
  ]);
  const imports = { wasi_snapshot_preview1: wasi.wasiImport };
  const { instance } = await WebAssembly.instantiate(source, imports);
  wasi.initialize(instance);
  const { memory, reserve_input, run_request, response_ptr } = instance.exports;
  return (request) => {
    const input = encoder.encode(JSON.stringify(request));
    const offset = reserve_input(input.length);
    new Uint8Array(memory.buffer, offset, input.length).set(input);
    const length = run_request();
    const response = JSON.parse(decoder.decode(new Uint8Array(memory.buffer, response_ptr(), length)));
    if (!response.ok) throw new Error(response.error);
    return response.data;
  };
}
