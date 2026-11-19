/**
 * Harness events this plugin listens to or emits but the pinned `@deepseek-ai/*`
 * type packages do not declare.
 *
 * Declared once here rather than in the plugin entry so the module that uses an
 * event (the bridge, the API) does not have to own an ambient declaration for
 * it. Both events are documented against the installed loader/llm versions in
 * `core/live.ts` and the plugin README.
 *
 * @module dsh-agent-sdk-bridge/core/events
 */
declare module '@deepseek-ai/cordis' {
    interface Context {
        /** Present only in web compositions; reached through a nested inject. */
        webServer?: {
            register(route: {
                kind: 'exact' | 'prefix';
                path: string;
                handler: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => void | Promise<void>;
            }): () => void;
        };
        /** Present when a filesystem provider is mounted; reached by inject. */
        fs?: {
            processPathFromHostPath?(hostPath: string): string | undefined;
        };
    }
    interface Events {
        /**
         * The loader committed a volatile-only config edit into this fiber.
         *
         * Emitted by `cordis-plugin-loader` from `Entry._commitVolatile` with the
         * config paths whose cells changed. The plugin does not restart for such an
         * edit, so this is the only notification that one happened; see
         * `core/live.ts`.
         *
         * @param paths - one path array per committed field, e.g. `[['displayName']]`.
         */
        'loader/volatile-update'(paths: readonly (readonly string[])[]): void;
        /**
         * One provider's advertised models or display metadata changed.
         *
         * The host forwards it to every connected GUI, whose model picker reloads
         * the catalog. Declared here because the `@deepseek-ai/dsh-llm` version this
         * plugin compiles against predates the event, while the harnesses it runs
         * on declare and dispatch it; emitting an event a slightly older host does
         * not know is harmless — nothing listens.
         *
         * @param provider - the route whose catalog changed.
         */
        'llm/models-updated'(provider: string): void;
    }
}
export {};
