/**
 * Interactive stdin prompts for the login CLI.
 *
 * Kept dependency-free. Password input is masked by overriding readline's
 * `_writeToOutput`, which is the conventional way to do this in Node. It needs
 * a TTY, so non-interactive use (piped stdin, `docker run` without `-it`) falls
 * back to an unmasked read rather than hanging.
 */
import readline from 'node:readline/promises';

/**
 * @param {string} question
 * @returns {Promise<string>}
 */
export async function ask(question) {
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
    });
    try {
        return (await rl.question(question)).trim();
    } finally {
        rl.close();
    }
}

/**
 * @param {string} question
 * @returns {Promise<string>}
 */
export async function askHidden(question) {
    if (!process.stdin.isTTY) {
        return ask(question);
    }

    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
        terminal: true
    });

    // Echo the prompt itself, swallow everything typed after it.
    rl._writeToOutput = (chunk) => {
        if (chunk.includes(question)) {
            rl.output.write(question);
        }
    };

    try {
        return (await rl.question(question)).trim();
    } finally {
        rl.close();
        process.stdout.write('\n');
    }
}
