/**
 * Aura Semantic Hook for Gemini CLI
 */
const fs = require('fs');
const readline = require('readline');

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: false
});

let inputData = '';

rl.on('line', (line) => {
  inputData += line;
});

rl.on('close', () => {
    try {
        if (!inputData) {
            // Provide a default fallback to ensure valid JSON is always printed
            console.log(JSON.stringify({}));
            return;
        }

        const context = JSON.parse(inputData);
        const { event, history } = context;

        if (event === 'SessionStart') {
            console.error("\n\x1b[36mℹ Powered by Aura:\x1b[0m");
            console.error("    This conversation is being semantically tracked by the Aura Physics Engine.");
            console.error("    Your architectural intent will be linked to the Merkle-Graph.\n");
        }

        if (event === 'AfterAgent' && history && history.length > 0) {
            // Extract the latest AI turn message as the intent
            const lastMessage = history[history.length - 1];
            if (lastMessage && lastMessage.role === 'model' && lastMessage.parts && lastMessage.parts.length > 0) {
                const intent = lastMessage.parts[0].text;
                // Strip code blocks and keep the first meaningful line
                const cleanIntent = intent.replace(/```[\s\S]*?```/g, '').trim().split('\n')[0];
                fs.writeFileSync('.gemini.intent', `[Gemini CLI] ${cleanIntent}`);
            }
        }
        
        // Hooks MUST return the context payload via stdout so the CLI can continue
        console.log(JSON.stringify(context));
        
    } catch (e) {
        console.error("Aura Hook Error: " + e.message);
        // Fallback to empty context to prevent crashing the CLI
        console.log(JSON.stringify({}));
    }
});