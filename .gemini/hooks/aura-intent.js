/**
 * Aura Semantic Hook for Gemini CLI
 */
const fs = require('fs');

module.exports = async (context) => {
    const { event, history } = context;

    if (event === 'SessionStart') {
        console.log("\x1b[36mℹ Powered by Aura:\x1b[0m");
        console.log("    This conversation is being semantically tracked by the Aura Physics Engine.");
        console.log("    Your architectural intent will be linked to the Merkle-Graph.\n");
        return;
    }

    if (event === 'AfterAgent') {
        // Extract the latest AI turn message as the intent
        const lastMessage = history[history.length - 1];
        if (lastMessage && lastMessage.role === 'model') {
            const intent = lastMessage.parts[0].text;
            // Strip code blocks and keep the first meaningful line
            const cleanIntent = intent.replace(/```[\s\S]*?```/g, '').trim().split('\n')[0];
            fs.writeFileSync('.gemini.intent', `[Gemini CLI] ${cleanIntent}`);
        }
    }
};
