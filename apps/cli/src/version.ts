// apps/cli/package.json の version を正とする（ビルドすると、この値が CLI に埋め込まれる）
import pkg from "../package.json" with { type: "json" };

export const CLI_VERSION: string = pkg.version;
