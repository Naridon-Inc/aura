/// <reference types="vite/client" />

// The oniguruma WebAssembly binary, imported as a bundled asset URL. Vite emits
// the file and hands back its resolved URL; the TextMate engine fetches it to
// feed `vscode-oniguruma`'s `loadWASM`.
declare module "*.wasm?url" {
  const url: string;
  export default url;
}
