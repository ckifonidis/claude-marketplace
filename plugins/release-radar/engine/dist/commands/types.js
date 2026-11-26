/** Shared shapes of the CLI commands. */
/** The context's sleep, or a real timer when the context supplies none. */
export function sleeper(context) {
    return context.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
}
