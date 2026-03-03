# Remotion Video Prompts for Aura

Here are the prompts, translated from your example into the **Aura Context**, following the exact best-practice animation instructions you requested. You can use these in any AI code generator (like Claude, Cursor, or ChatGPT) or paste them directly into a fresh Remotion project context.

## 1. The "Hero Intro" Prompt (Scene 1)
> Use remotion best practices. Import the 'Aura Hero' slide component into the project. In Remotion, make a new composition where you render the Hero slide padded generously on a dark #050505 full HD background. While the composition is running for 5 seconds, slowly, very subtly, zoom into it and slightly rotate the article in 3d from left to right. The overall rotation should be around 15deg for each axis. At the beginning, blur the whole composition and unblur it over 1 second. After the blur is done, evolve a highlighter from left to right using rough.js over the words "Semantic Time Machine". Make sure the marker appears behind the text. When installing new dependencies, check for existing lockfiles and use the right package manager.

## 2. The "Semantic Scalpel" Prompt (Scene 2)
> Use remotion best practices. Import the 'Semantic Scalpel' terminal slide into the project. In Remotion, make a new composition where you load the slide on a dark full HD background. While the composition is running for 5 seconds, slowly, very subtly, zoom into the terminal block and slightly rotate it in 3d from left to right (around 15deg). At the beginning, blur the whole composition and unblur it over 1 second. After the blur is done, evolve a highlighter from left to right using rough.js over the text "$ aura rewind auth_middleware" and "✓ Function reverted. Rest of file remains untouched." Make sure the highlighter is emerald green (#34d399) and appears behind the text. 

## 3. The "Flaw vs Solution" Pan Prompt (Scene 3)
> Use remotion best practices. Create a composition that contains both the 'Legacy Git' diff box and the 'Aura Merkle-Graph' box. Place them side-by-side on a dark #050505 full HD canvas. For the first 3 seconds, focus the camera purely on the Legacy Git box (showing the Fatal Merge Conflict). Then, over 2 seconds, use a spring animation to smoothly pan the camera horizontally to the right, landing perfectly on the Aura Merkle-Graph box. Once the pan is complete, evolve a highlighter from left to right using rough.js over the words "Autonomous Arbitration Successful". Make sure the marker appears behind the text.

## 4. The "Logo GIF" Prompt
> Use remotion best practices to create an AuraLogo composition. The logo consists of an outer circle (stroke width 2.5) and an inner circle (radius 4.5) using the color #34d399 on a dark #050505 background. The composition should be 500x500 pixels, 30fps, and last for 4 seconds (120 frames). Animate the outer circle's strokeDashoffset so it looks like it is drawing itself. Animate the inner circle using a subtle spring scale (breathing effect). Apply a slow, continuous rotation to the entire SVG group (0 to 360 degrees) so it loops perfectly when exported as a GIF. Include the word "AURA" below the logo, fading in between frame 30 and 60.

---

*Note: I have also gone ahead and written the actual Remotion project code for these animations in the `aura-promo` folder! You can run it locally to see the results.*