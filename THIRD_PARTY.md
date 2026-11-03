# Third-party notices

Flaxia Studio is a separate application that reuses Flaxia design tokens and
builds on the following projects.

| Project                                                            | License           | Use                                                                             |
| ------------------------------------------------------------------ | ----------------- | ------------------------------------------------------------------------------- |
| [container2wasm](https://github.com/container2wasm/container2wasm) | Apache-2.0        | Linux → WebAssembly conversion                                                  |
| [browser_wasi_shim](https://github.com/bjorn3/browser_wasi_shim)   | MIT OR Apache-2.0 | WASI host in the browser (vendored in `public/linux-runtime/browser_wasi_shim`) |
| [Monaco Editor](https://github.com/microsoft/monaco-editor)        | MIT               | Editor and language services                                                    |
| [xterm.js](https://github.com/xtermjs/xterm.js)                    | MIT               | Terminal UI                                                                     |
| [lucide](https://github.com/lucide-icons/lucide)                   | ISC               | Icons                                                                           |
| [fflate](https://github.com/101arrowz/fflate)                      | MIT               | ZIP import/export                                                               |

Generated container2wasm images bundle emulator and guest operating system code
(Bochs/QEMU, Linux, GRUB, runc, BusyBox, and the image's own packages). Their
licenses ship inside the image (`/usr/share/doc/*/copyright`) and in the
container2wasm acknowledgements. Keep this notice when redistributing an image.
