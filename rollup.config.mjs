import resolve from "@rollup/plugin-node-resolve";
import commonjs from "@rollup/plugin-commonjs";
import typescript from "@rollup/plugin-typescript";
import replace from "@rollup/plugin-replace";
import postcss from "rollup-plugin-postcss";
import terser from "@rollup/plugin-terser";
import copy from "rollup-plugin-copy";
import autoprefixer from "autoprefixer";
import cssnano from "cssnano";

export default {
    input: "src/index.tsx",
    output: {
        file: "dist/akira-player.umd.js",
        format: "umd",
        name: "AkiraPlayer",
        sourcemap: true,
        exports: "named"
    },
    plugins: [
        replace({
            preventAssignment: true,
            "process.env.NODE_ENV": JSON.stringify("production")
        }),
        resolve({ browser: true }),
        commonjs(),
        typescript({ tsconfig: "./tsconfig.json" }),
        postcss({
            extract: "akira-player.css",
            minimize: true,
            plugins: [autoprefixer(), cssnano()]
        }),
        copy({
            targets: [{ src: "src/assets/**/*", dest: "dist/assets" }],
            hook: "writeBundle"
        }),
        terser()
    ]
};