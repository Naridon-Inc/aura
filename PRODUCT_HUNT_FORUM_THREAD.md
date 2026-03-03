Why we paused our main product to rebuild version control for AI.

Hey everyone! I’m the founder of Aura. 

A few months ago, our engineering sprints at Naridon started grinding to a halt. We were relying heavily on Cursor and Claude to generate code. But every time an AI agent hallucinated a massive refactor, standard Git gave us a chaotic, unresolvable wall of red and green text conflicts.

We realized Git was built for humans typing linearly, not for AI generating 4,000 lines a minute. So, we paused our main product to build a fix.

Tomorrow we are launching **Aura: an AI-Native Semantic Version Control system.** It lives directly on top of Git, but instead of tracking text lines, it tracks the mathematical logic (AST) of your code.

With Aura you can:
🔪 Use a "Semantic Scalpel" to revert a single broken function an AI wrote without losing the 500 lines of good code around it.
🧠 Trigger "The Amnesia Protocol" to surgically wipe an AI's chat memory so it stops looping on a bad hallucination.

It’s 100% open-source and local. 

What is the worst merge-conflict disaster you've had recently when using AI coding tools? I'd love to hear your horror stories before we go live!
