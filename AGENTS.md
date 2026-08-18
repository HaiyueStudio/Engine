# HaiyueStudio Engine repository instructions

- Node.js 22 or newer is required.
- `engine`, `animation-spec`, and `shader-language` are independent foundations; `extensions` may consume
  public Engine and animation-spec exports. Engine examples consume public package exports.
- Do not add Editor, UI, Games, or AIStudio source dependencies.
- Keep `@haiyue/engine` root as the stable golden path. Public subpaths and package changes require API review.
- Generated shaders are changed through shader-language generators, never by hand.
- Run focused workspace typecheck/test/build first, then the repository `typecheck`, `test`, and `build` scripts.
