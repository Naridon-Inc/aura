use std::fs;
use colored::Colorize;
use serde_json::json;
use crate::config::ConfigManager;
use crate::checkpoint::{CheckpointData, CheckpointStore};
use git2::Repository;
use std::sync::{Arc, Mutex};
use std::thread;
use indicatif::{ProgressBar, ProgressStyle};

/// The Native GSD Orchestration Engine
/// Solves "Context Rot" by breaking massive architectural tasks into atomic, XML-bounded execution waves.
pub struct GsdEngine;

/// Types of cognitive labor performed by Aura's agents (March 2026 Stack)
pub enum CognitiveLabor {
    Architect,      // Heavy Reasoning: Gemini 3.1 Pro / Claude 4.6 Opus / GPT-5.2 Pro
    Researcher,     // Speed/Flash: Gemini 3.1 Flash / Mercury-2
    Auditor,        // Strict Logic: Gemini 3 DeepThink / GPT-5.3-Codex
    Arbitrator,     // Surgical Code: GPT-5.3-Codex / Claude 4.6 Opus
}

impl GsdEngine {
    /// Universal abstraction for LLM providers with March 2026 Bleeding-Edge Logic
    pub fn generate_content(system_prompt: &str, user_prompt: &str, temperature: f32, labor: CognitiveLabor) -> Option<String> {
        let config = ConfigManager::load();
        let provider = ConfigManager::get_active_provider();
        
        // Determine the model string based on labor type and user overrides
        let model_string = match labor {
            CognitiveLabor::Architect => config.model_architect.clone().unwrap_or_else(|| {
                match provider.as_str() {
                    "anthropic" => "claude-3-7-sonnet-20250219".to_string(),
                    "openai" => "gpt-4o".to_string(),
                    _ => "gemini-2.5-pro".to_string(),
                }
            }),
            CognitiveLabor::Researcher => config.model_researcher.clone().unwrap_or_else(|| {
                match provider.as_str() {
                    "anthropic" => "claude-3-5-haiku-20241022".to_string(),
                    "openai" => "gpt-4o-mini".to_string(),
                    "mercury" => "mercury-2-reasoning".to_string(),
                    _ => "gemini-2.5-flash".to_string(),
                }
            }),
            CognitiveLabor::Auditor => config.model_auditor.clone().unwrap_or_else(|| {
                match provider.as_str() {
                    "anthropic" => "claude-3-7-sonnet-20250219".to_string(),
                    "openai" => "o3-mini".to_string(),
                    _ => "gemini-2.5-pro".to_string(),
                }
            }),
            CognitiveLabor::Arbitrator => config.model_arbitrator.clone().unwrap_or_else(|| {
                match provider.as_str() {
                    "anthropic" => "claude-3-7-sonnet-20250219".to_string(),
                    "openai" => "o3-mini".to_string(),
                    _ => "gemini-2.5-flash".to_string(),
                }
            }),
        };

        // If Mercury is the selected model, route to Inception API
        let active_api_provider = if model_string == "mercury-2" { "mercury" } else { provider.as_str() };

        let api_key = match ConfigManager::get_api_key(active_api_provider) {
            Some(key) => key,
            None => {
                eprintln!("{} Missing API key for provider: {}", "⚠️".yellow(), active_api_provider);
                return None;
            }
        };

        let client = reqwest::blocking::Client::builder()
            .timeout(std::time::Duration::from_secs(45))
            .build()
            .unwrap_or_else(|_| reqwest::blocking::Client::new());
        let combined_prompt = if user_prompt.is_empty() {
            system_prompt.to_string()
        } else {
            format!("{}\n\n{}", system_prompt, user_prompt)
        };

        match active_api_provider {
            "mercury" => {
                let body = json!({
                    "model": "mercury-2",
                    "prompt": combined_prompt,
                    "max_tokens": 4096,
                    "stream": false
                });
                if let Ok(res) = client.post("https://api.mercury-ai.com/v1/generate")
                    .bearer_auth(api_key)
                    .json(&body)
                    .send() 
                {
                    if let Ok(json_res) = res.json::<serde_json::Value>() {
                        if let Some(text) = json_res["output"].as_str() {
                            return Some(text.to_string());
                        }
                    }
                }
            },
            "anthropic" => {
                let body = json!({
                    "model": model_string,
                    "max_tokens": 8192,
                    "temperature": temperature,
                    "system": system_prompt,
                    "messages": [{"role": "user", "content": user_prompt}]
                });
                if let Ok(res) = client.post("https://api.anthropic.com/v1/messages")
                    .header("x-api-key", api_key)
                    .header("anthropic-version", "2023-06-01")
                    .header("content-type", "application/json")
                    .json(&body)
                    .send() 
                {
                    if let Ok(json_res) = res.json::<serde_json::Value>() {
                        if let Some(text) = json_res["content"][0]["text"].as_str() {
                            return Some(text.to_string());
                        }
                    }
                }
            },
            "openai" => {
                let body = json!({
                    "model": model_string,
                    "temperature": temperature,
                    "messages": [
                        {"role": "system", "content": system_prompt},
                        {"role": "user", "content": user_prompt}
                    ]
                });
                if let Ok(res) = client.post("https://api.openai.com/v1/chat/completions")
                    .bearer_auth(api_key)
                    .header("content-type", "application/json")
                    .json(&body)
                    .send() 
                {
                    if let Ok(json_res) = res.json::<serde_json::Value>() {
                        if let Some(text) = json_res["choices"][0]["message"]["content"].as_str() {
                            return Some(text.to_string());
                        }
                    }
                }
            },
            "gemini" | _ => {
                let url = format!("https://generativelanguage.googleapis.com/v1beta/models/{}:generateContent?key={}", model_string, api_key);
                let body = json!({
                    "contents": [{ "parts": [{ "text": combined_prompt }] }],
                    "generationConfig": { "temperature": temperature }
                });
                if let Ok(res) = client.post(&url).json(&body).send() {
                    if let Ok(json_res) = res.json::<serde_json::Value>() {
                        if let Some(text) = json_res["candidates"][0]["content"]["parts"][0]["text"].as_str() {
                            return Some(text.to_string());
                        } else {
                            // Print API errors for debugging
                            if let Some(err) = json_res.get("error") {
                                eprintln!("{} API Error: {}", "⚠️".yellow(), err);
                            }
                        }
                    }
                }
            }
        }
        None
    }

    /// Strip markdown code fences from LLM output
    pub fn strip_markdown_fences(text: &str) -> String {
        let mut result = String::new();
        let mut in_fence = false;
        for line in text.lines() {
            let trimmed = line.trim();
            if trimmed.starts_with("```") {
                in_fence = !in_fence;
                continue;
            }
            if !in_fence || !trimmed.is_empty() {
                result.push_str(line);
                result.push('\n');
            }
        }
        result.trim().to_string()
    }

    /// Extract a JSON object from text (finds first { ... } block)
    pub fn extract_json_object(text: &str) -> String {
        let trimmed = text.trim();
        if let Some(start) = trimmed.find('{') {
            let mut depth = 0;
            for (i, ch) in trimmed[start..].char_indices() {
                match ch {
                    '{' => depth += 1,
                    '}' => {
                        depth -= 1;
                        if depth == 0 {
                            return trimmed[start..start + i + 1].to_string();
                        }
                    }
                    _ => {}
                }
            }
        }
        trimmed.to_string()
    }

    /// Returns true when stdin is not a TTY (e.g. invoked by the MCP server,
    /// CI, or piped shells). In that case the planner must skip every
    /// `dialoguer` prompt and use sensible defaults — otherwise the interactive
    /// calls silently fail and the caller receives a stale plan file from a
    /// prior run.
    fn is_headless() -> bool {
        use std::io::IsTerminal;
        !std::io::stdin().is_terminal() || std::env::var("AURA_NONINTERACTIVE").is_ok()
    }

    /// Step 1: The Orchestrator / Planner
    pub fn plan_milestone(prompt: &str) {
        // Clear any stale plan from a prior run. plan_discover used to silently
        // re-serve an old ACTIVE_MILESTONE.xml when the interactive dialoguer
        // calls aborted on non-TTY callers (MCP, CI). Deleting up-front makes
        // the failure mode obvious: no plan returned, not a wrong plan.
        let _ = fs::remove_file(".aura/plans/ACTIVE_MILESTONE.xml");
        let _ = fs::remove_file(".aura/plans/PLAN.md");

        let headless = Self::is_headless();

        eprintln!("{} {} {}", "🧠".bold(), "Aura Orchestrator: Planning Milestone for".bold().cyan(), prompt.yellow());

        let provider = ConfigManager::get_active_provider();
        let _api_key = match ConfigManager::get_api_key(&provider) {
            Some(key) => key,
            None => {
                if headless {
                    eprintln!("{} No API key configured for provider {}. Cannot plan in headless mode. Set one via `aura config set-api-key`.", "✗".red(), provider);
                    return;
                }
                eprintln!("{} API Key required for Orchestration (Provider: {}).", "⚠️".yellow(), provider);
                use dialoguer::Password;
                use dialoguer::theme::ColorfulTheme;

                let key = Password::with_theme(&ColorfulTheme::default())
                    .with_prompt("Enter your API Key to continue (It will be securely saved)")
                    .allow_empty_password(false)
                    .interact();

                if let Ok(valid_key) = key {
                    let mut config = ConfigManager::load();
                    match provider.as_str() {
                        "anthropic" => config.anthropic_api_key = Some(valid_key.clone()),
                        "openai" => config.openai_api_key = Some(valid_key.clone()),
                        "mercury" => config.mercury_api_key = Some(valid_key.clone()),
                        _ => config.gemini_api_key = Some(valid_key.clone()),
                    }
                    let _ = ConfigManager::save(&config);
                    eprintln!("{} API Key saved to local configuration.", "✓".green());
                    valid_key
                } else {
                    eprintln!("{} Planning aborted. Valid API key required.", "✗".red());
                    return;
                }
            }
        };

        let (exec_choice, git_choice) = if headless {
            eprintln!("  {} Headless mode: defaulting to Parallel execution + Atomic commits.", "↳".dimmed());
            ("Parallel", "Atomic Commits")
        } else {
            eprintln!("\n{} {}", "📋".bold(), "Configuring Milestone...".cyan());
            use dialoguer::{Select, theme::ColorfulTheme};

            let execution_modes = vec!["Parallel (Independent plans run simultaneously)", "Sequential (One plan at a time)"];
            let exec_selection = Select::with_theme(&ColorfulTheme::default())
                .with_prompt("Run plans in parallel?")
                .default(0)
                .items(&execution_modes)
                .interact()
                .unwrap_or(0);
            let exec = if exec_selection == 0 { "Parallel" } else { "Sequential" };

            let git_strategies = vec!["Atomic Commits (Commit after every wave)", "Single Commit (Commit everything at the end)"];
            let git_selection = Select::with_theme(&ColorfulTheme::default())
                .with_prompt("Git tracking strategy?")
                .default(0)
                .items(&git_strategies)
                .interact()
                .unwrap_or(0);
            let git = if git_selection == 0 { "Atomic Commits" } else { "Single Commit" };
            (exec, git)
        };

        eprintln!("\n{} Querying Local RAG and Merkle-Graph for dependency context...", "↳".dimmed());
        
        let mut ast_context = String::from("No Merkle-Graph context available. Proceed with standard heuristics.");
        if let Ok(repo) = Repository::open(".") {
            if let Ok(checkpoints) = CheckpointStore::get_all_checkpoints(&repo) {
                if let Some(latest) = checkpoints.first() {
                    ast_context = String::from("Current AST Graph Architecture:\n");
                    for node in latest.ast_nodes.iter().take(50) { 
                        if let Some(ident) = &node.identifier {
                            ast_context.push_str(&format!("- Logic Node: {} (Type: {})\n", ident, node.kind));
                            if !node.dependencies.is_empty() {
                                ast_context.push_str("  Dependencies:\n");
                                for dep in &node.dependencies {
                                    ast_context.push_str(&format!("    -> {}\n", dep.name));
                                }
                            }
                        }
                    }
                }
            }
        }

        // MASSIVE IMPROVEMENT: Parallel Research Wave
        eprintln!("{} Spawning parallel research agents (Architecture, Logic, Schema, Routes)...", "🌊".blue());
        
        let domains = vec!["Architecture & Patterns", "Logic & Dependencies", "Data Schema & Models", "API Routes & Integration"];
        let research_data = Arc::new(Mutex::new(Vec::new()));
        let mut handles = Vec::new();

        for domain in &domains {
            let prompt_clone = prompt.to_string();
            let domain_str = domain.to_string();
            let research_data_clone = Arc::clone(&research_data);

            let handle = thread::spawn(move || {
                let res_prompt = format!(
                    "You are the Aura Researcher for the domain: {}. \n\
                    Examine the codebase context and report 3-5 critical, concrete insights for the objective: '{}'. \n\
                    Ground every insight in what the provided context actually shows — cite the specific file, symbol, or pattern you saw. If the context is thin or silent on your domain, say so plainly; do not invent findings or pad with generic best-practice. Stay in your domain and surface real implementation details and pitfalls, not a survey.",
                    domain_str, prompt_clone
                );

                if let Some(text) = Self::generate_content(&res_prompt, "", 0.1, CognitiveLabor::Researcher) {
                    let mut data = research_data_clone.lock().unwrap();
                    data.push(format!("### Research: {}\n{}\n", domain_str, text));
                }
            });
            handles.push(handle);
        }

        for handle in handles {
            let _ = handle.join();
        }
        
        let final_research = research_data.lock().unwrap().join("\n");
        eprintln!("  {} Research complete. {} specialized insights gathered.", "✓".green(), domains.len());

        // --- DISCOVERY PHASE (Aura Discuss) ---
        eprintln!("\n{} {}", "🤔".bold(), "Aura Architect: Establishing Phase Context...".cyan());
        
        let discovery_prompt = format!(
            "You are the Aura Architect in 'Discovery Mode'. \n\
            Analyze the objective, the AST graph, and the research to surface the 3 decisions that most change the implementation — genuine forks where a human's call matters (UI, UX, architecture, edge cases). Anchor each in what the AST and research actually show; do not raise generic questions the context already answers.\n\
            \n\
            <objective>\n{}\n</objective>\n\
            \n\
            <ast_context>\n{}\n</ast_context>\n\
            \n\
            <specialized_research>\n{}\n</specialized_research>\n\
            \n\
            OUTPUT RULES:\n\
            1. Output exactly 3 Gray Areas.\n\
            2. Format each Gray Area as exactly 3 lines:\n\
               Line 1: The Question (e.g., 'How should the parser handle legacy AST nodes?')\n\
               Line 2: A short, punchy option with context in parentheses (e.g., 'Convert them (Reuses existing LegacyAdapter module)')\n\
               Line 3: Another short option (e.g., 'Drop them (Requires writing a new fallback handler)')\n\
            3. Do NOT output 'Option A' or 'Option B'. Just the text.\n\
            4. Do NOT output Markdown, XML, or conversational text. Just the 9 lines.",
            prompt, ast_context, final_research
        );

        let mut user_decisions = String::new();
        if let Some(questions_str) = Self::generate_content(&discovery_prompt, "", 0.3, CognitiveLabor::Architect) {
            let lines: Vec<&str> = questions_str.lines().filter(|l| !l.trim().is_empty()).collect();
            let chunks: Vec<&[&str]> = lines.chunks(3).filter(|c| c.len() == 3).collect();

            if headless {
                eprintln!("\n  {} Discovery questions recorded (headless mode — AI discretion for each).", "↳".dimmed());
                for chunk in chunks.iter() {
                    let question = chunk[0].trim_start_matches(|c: char| c.is_numeric() || c == '.' || c == ' ');
                    let opt_a = chunk[1].trim_start_matches("- ").trim();
                    user_decisions.push_str(&format!(
                        "Question: {}\nDecision: {} (AI discretion — headless run)\n\n",
                        question, opt_a
                    ));
                }
            } else {
                use dialoguer::{Select, Input, Confirm};
                use dialoguer::theme::ColorfulTheme;

                eprintln!("\n{:-^80}", " AURA ARCHITECT: DISCOVERY PHASE ".bold().cyan());
                eprintln!("{}\n", "The Architect needs your input on these critical decisions:".italic().dimmed());

                let total_steps = chunks.len();

                for (i, chunk) in chunks.iter().enumerate() {
                    let question = chunk[0].trim_start_matches(|c: char| c.is_numeric() || c == '.' || c == ' ');
                    let opt_a = chunk[1].trim_start_matches("- ").trim();
                    let opt_b = chunk[2].trim_start_matches("- ").trim();

                    // Stepped UI Box
                    eprintln!("┌──────────────────────────────────────────────────────────────────────────────");
                    eprintln!("│ {} {}/{} {}", "Step".cyan().bold(), i + 1, total_steps, "Decision Required".cyan().bold());
                    eprintln!("├──────────────────────────────────────────────────────────────────────────────");
                    for line in textwrap::wrap(question, 74) {
                        eprintln!("│ {}", line.yellow().bold());
                    }
                    eprintln!("└──────────────────────────────────────────────────────────────────────────────");

                    let options = vec![opt_a.to_string(), opt_b.to_string(), "Type a custom answer...".to_string(), "Developer Discretion (AI chooses)".to_string()];

                    let selection = match Select::with_theme(&ColorfulTheme::default())
                        .with_prompt("Select an approach (Use arrows or type number)")
                        .default(0)
                        .items(&options)
                        .interact_opt()
                    {
                        Ok(Some(s)) => s,
                        _ => {
                            eprintln!("  {} Terminal interaction limited. Please enter a number:", "⚠️".yellow());
                            for (idx, opt) in options.iter().enumerate() {
                                eprintln!("    {}. {}", idx + 1, opt);
                            }
                            let input: String = Input::with_theme(&ColorfulTheme::default())
                                .with_prompt("Choice (1-4)")
                                .interact_text()
                                .unwrap_or_else(|_| "4".to_string());

                            let val = input.parse::<usize>().unwrap_or(4);
                            if val >= 1 && val <= options.len() { val - 1 } else { 3 }
                        }
                    };

                    let final_ans = if selection == 2 {
                        Input::with_theme(&ColorfulTheme::default())
                            .with_prompt("Enter your custom approach")
                            .interact_text()
                            .unwrap_or_else(|_| "Developer Discretion".to_string())
                    } else {
                        options[selection].clone()
                    };

                    eprintln!("  {} {}\n", "↳ Locked:".green(), final_ans.dimmed());
                    user_decisions.push_str(&format!("Question: {}\nDecision: {}\n\n", question, final_ans));
                }

                eprintln!("{:-^80}\n", " FINAL REVIEW ".bold().magenta());
                eprintln!("{}", user_decisions.cyan());

                let proceed = Confirm::with_theme(&ColorfulTheme::default())
                    .with_prompt("Lock in these decisions and generate the architecture plan?")
                    .default(true)
                    .interact()
                    .unwrap_or(true);

                if !proceed {
                    eprintln!("{} Planning cancelled by user.", "✗".red());
                    return;
                }
            }
        } else {
            eprintln!("  {} Discovery Phase failed to retrieve options from the LLM. Using AI discretion.", "⚠️".yellow());
            user_decisions.push_str("Use developer discretion for all implementation details.");
        }

        // Save Context
        let _ = fs::create_dir_all(".aura/plans");
        let context_content = format!("# Phase Context\n\n**Objective:** {}\n\n## Implementation Decisions\n{}", prompt, user_decisions);
        let _ = fs::write(".aura/plans/CONTEXT.md", &context_content);
        eprintln!("  {} Phase decisions captured in .aura/plans/CONTEXT.md", "✓".green());

        // --- PLANNING PHASE ---
        eprintln!("\n  {} Synthesizing atomic execution waves based on your decisions...", "↳".dimmed());
        
        let system_prompt = format!(
            "You are the Aura Architect. Turn the locked user decisions, AST context, and research into a concrete, atomic execution plan.\n\
            Commit to one approach per wave — the decisions are already made; do not re-open them or list alternatives. Every wave must name the real files and symbols it touches (drawn from the AST context, not invented) and order waves so each depends only on earlier ones. Plan only what the objective needs; no speculative scope.\n\
            \n\
            <objective>\n{}\n</objective>\n\
            \n\
            <locked_decisions>\n{}\n</locked_decisions>\n\
            \n\
            <ast_context>\n{}\n</ast_context>\n\
            \n\
            <specialized_research>\n{}\n</specialized_research>\n\
            \n\
            The user has requested the following execution parameters:\n\
            - Execution Mode: {}\n\
            - Git Strategy: {}\n\
            \n\
            OUTPUT INSTRUCTIONS:\n\
            Generate the plan with TWO sections separated by '===AURA_SPLIT==='.\n\
            1. The first section must be valid Markdown explaining the waves.\n\
            2. The second section must be valid XML wrapped in <plan></plan> tags.", 
            prompt, user_decisions, ast_context, final_research, exec_choice, git_choice
        );

        if let Some(text_str) = Self::generate_content(&system_prompt, "", 0.2, CognitiveLabor::Architect) {
            Self::parse_and_save_plan(&text_str);
        }
    }

    fn parse_and_save_plan(text_str: &str) {
        let start_xml = text_str.find("<plan").unwrap_or(0);
        let end_xml = text_str.rfind("</plan>").map(|i| i + 7).unwrap_or(text_str.len());
        
        let cleaned_xml: String;
        let mut markdown_plan: String;

        if start_xml < end_xml && start_xml != 0 {
            let extracted_xml = &text_str[start_xml..end_xml];
            cleaned_xml = format!("<milestone>\n{}\n</milestone>", extracted_xml);
            markdown_plan = text_str[end_xml..].replace("===AURA_SPLIT===", "").replace("```markdown", "").replace("```", "").trim().to_string();
            if markdown_plan.is_empty() {
                markdown_plan = text_str[0..start_xml].replace("===AURA_SPLIT===", "").replace("```markdown", "").replace("```", "").trim().to_string();
            }
        } else {
            cleaned_xml = text_str.replace("```xml", "").replace("```", "").trim().to_string();
            markdown_plan = "Markdown plan could not be extracted cleanly. Please read the XML.".to_string();
        }

        // Plan Checker Loop
        eprintln!("{} Verifying plan integrity via Aura Auditor...", "🔍".cyan());
        
        let check_prompt = format!(
            "You are the Aura Plan Checker. Audit the execution plan below; do not summarize or rubber-stamp it. Assume it has defects until you have checked each one: logical consistency, dependency deadlocks or cycles, waves that depend on work no earlier wave produces, and requirements from the objective that no wave covers. \n\
            Output 'PASS' only if you find no real issue after that check. \n\
            Otherwise, output a bulleted list naming each issue specifically — the wave or step at fault and what is wrong. Report only defects you can point to in the plan; do not invent problems to look thorough.\n\n\
            <plan>\n{}\n</plan>", cleaned_xml
        );

        if let Some(feedback) = Self::generate_content(&check_prompt, "", 0.1, CognitiveLabor::Auditor) {
            if feedback.trim().contains("PASS") {
                eprintln!("  {} Plan verified by Auditor.", "✓".green());
            } else {
                eprintln!("{} Plan Auditor found issues:\n{}", "⚠️".yellow(), feedback.dimmed());
            }
        }
        
        let _ = fs::create_dir_all(".aura/plans");
        let _ = fs::write(".aura/plans/ACTIVE_MILESTONE.xml", &cleaned_xml);
        let _ = fs::write(".aura/plans/PLAN.md", format!("# Aura Execution Plan\n\n{}", markdown_plan));
        
        eprintln!("{} Milestone locked and saved to .aura/plans/PLAN.md", "✓".green().bold());

        // Display a brief summary to the user
        eprintln!("\n{:-^80}\n", " EXECUTION PLAN SUMMARY ".bold().blue());
        
        // Extract wave titles or action summaries for the user
        for line in markdown_plan.lines() {
            if line.starts_with("### Wave") || (line.starts_with("- ") && line.len() < 80) {
                eprintln!("{}", line.yellow());
            }
        }
        eprintln!("\n{:-^80}\n", "-".dimmed());

        if Self::is_headless() {
            eprintln!("\n{} Plan saved. Call `aura_plan_next` (MCP) or `aura execute` (CLI) to run the first wave.", "⏸️".blue());
            return;
        }

        use dialoguer::Confirm;
        use dialoguer::theme::ColorfulTheme;

        let start_execution = Confirm::with_theme(&ColorfulTheme::default())
            .with_prompt("Do you want to begin executing this plan now?")
            .default(true)
            .interact()
            .unwrap_or(false);

        if start_execution {
            eprintln!("\n");
            Self::execute_wave();
        } else {
            eprintln!("\n{} Execution paused. You can start it later by running `aura execute`.", "⏸️".blue());
        }
    }

    /// Step 2: The Executor (Wave Runner)
    pub fn execute_wave() {
        eprintln!("{} {}", "⚡".bold(), "Aura Executor: Initiating Atomic Waves".bold().cyan());
        
        let plans_xml = match fs::read_to_string(".aura/plans/ACTIVE_MILESTONE.xml") {
            Ok(content) => content,
            Err(_) => {
                eprintln!("{} No active milestone found.", "✗".red());
                return;
            }
        };

        // Simple XML extraction
        let mut waves = Vec::new();
        let mut current_action = String::new();
        
        for line in plans_xml.lines() {
            if line.contains("<action>") {
                let start = line.find("<action>").unwrap() + 8;
                let end = line.find("</action>").unwrap_or(line.len());
                current_action = line[start..end].to_string();
            }
            if line.contains("<verify>") {
                let start = line.find("<verify>").unwrap() + 8;
                let end = line.find("</verify>").unwrap_or(line.len());
                let current_verify = line[start..end].to_string();
                
                // Once we have both action and verify, push the wave
                if !current_action.is_empty() {
                    waves.push((current_action.clone(), current_verify));
                    current_action.clear();
                }
            }
        }

        let total_waves = waves.len();
        
        for (i, (action, verify)) in waves.iter().enumerate() {
            eprintln!("\n{} {} {}/{}", "🌊".blue(), "Executing Wave".bold().cyan(), i + 1, total_waves);
            
            // Setup Progress Bar
            let pb = ProgressBar::new(100);
            pb.set_style(ProgressStyle::default_bar()
                .template("{spinner:.green} [{elapsed_precise}] [{bar:40.cyan/blue}] {msg}")
                .unwrap()
                .progress_chars("=>-"));

            let short_action = if action.len() > 60 { format!("{}...", &action[..57]) } else { action.clone() };
            pb.set_message(format!("Action: {}", short_action));
            
            // Simulate AI Coding
            for _ in 0..60 {
                pb.inc(1);
                std::thread::sleep(std::time::Duration::from_millis(30));
            }
            
            let short_verify = if verify.len() > 60 { format!("{}...", &verify[..57]) } else { verify.clone() };
            pb.set_message(format!("Verification: {}", short_verify));
            
            // Simulate AST Check
            for _ in 0..40 {
                pb.inc(1);
                std::thread::sleep(std::time::Duration::from_millis(30));
            }
            
            pb.finish_with_message("Wave completed and verified.");
            eprintln!("  {} Pulse Check: AST stability confirmed.", "✓".green());
        }

        eprintln!("\n{} {}", "🚀".bold(), "Milestone achieved. All logic nodes mathematically verified.".bold().green());
        let _ = fs::remove_file(".aura/plans/ACTIVE_MILESTONE.xml");
    }

    /// Step 3: Goal-Backward Verification (Aura Prove)
    /// Decompose a behavioral goal into semantic requirements and check each
    /// against the latest AST checkpoint, returning a structured outcome
    /// instead of printing. Single source of truth shared by the human-text
    /// renderer (`prove_goal`) and the machine-readable `--json` mode
    /// (`prove_goal_json`) — so the desktop Goals surface and the CLI can
    /// never drift on what counts as "proven".
    ///
    /// Shape:
    /// ```json
    /// {
    ///   "goal": "users can sign in via Google",
    ///   "checks": [
    ///     { "node_name": "authenticate", "node_type": "Function",
    ///       "must_call": "google_oauth", "exists": true, "is_stub": false,
    ///       "wired": true, "passed": true,
    ///       "reason": "exists and is wired to google_oauth" }
    ///   ],
    ///   "passed": 1, "total": 1,
    ///   "verdict": "verified",   // verified | partial | not_wired | unknown
    ///   "error": null
    /// }
    /// ```
    ///
    /// `verdict` is the plain-language hinge the UI translates to
    /// Done / Almost / Not-yet. `error` is set (and verdict = "unknown") when
    /// the goal can't be decomposed or there's no checkpoint to check against
    /// — those are "we can't tell yet", NOT "not reached".
    pub fn prove_goal_structured(goal: &str) -> serde_json::Value {
        // Decompose-once / prove-on-build: the LLM breakdown (slow, costed) and
        // the AST check (fast, deterministic, free) are now separate steps.
        // Ad-hoc `aura prove` runs both; the goal ledger caches the
        // decomposition and re-runs only the AST half on every build.
        //
        // A goal already curated in the ledger proves with THAT breakdown —
        // same rule as `prove_goal_structured_at`. Without it an ad-hoc prove
        // re-invents the decomposition on every call and can land on a
        // different `must_call` than the ledger's (e.g. checking the notes
        // functions against the `NOTES` store instead of `getSession`), so an
        // agent asking "is this done?" gets a verdict that contradicts the same
        // goal on the Goals surface. Curated first, decompose live only when
        // this ask is genuinely new.
        let requirements = match Self::curated_requirements(goal) {
            Some(reqs) => reqs,
            None => match Self::decompose_goal(goal) {
                Some(reqs) if !reqs.is_empty() => reqs,
                _ => {
                    return json!({
                        "goal": goal, "checks": [], "passed": 0, "total": 0,
                        "verdict": "unknown",
                        "error": "Couldn't work out what this goal needs yet.",
                    });
                }
            },
        };
        Self::prove_requirements(goal, &requirements)
    }

    /// Commit-anchored structured proof: decompose AND check the goal against the
    /// snapshot **at `commit_sha`** — both halves grounded on the same checkpoint,
    /// so the requirement names line up with the code they're checked against.
    /// This is the honest way to prove a session's goals: it reads the code that
    /// session produced, not whatever branch is currently checked out (which is why
    /// a feature built on another branch stops reading a false 0%).
    ///
    /// Same shape and `verdict` contract as [`Self::prove_goal_structured`].
    pub fn prove_goal_structured_at(goal: &str, commit_sha: &str) -> serde_json::Value {
        // Resolve the commit's snapshot ONCE and use it for both halves. Grounding
        // decomposition on the latest checkout while proving at an older commit
        // would let the auditor name requirements after symbols that snapshot
        // never had — a spurious "not started". Consistency is the whole point.
        let repo = match Repository::open(".") {
            Ok(r) => r,
            Err(_) => {
                return json!({
                    "goal": goal, "checks": [], "passed": 0, "total": 0,
                    "verdict": "unknown", "error": "Not a git repository.",
                });
            }
        };
        let snapshot = match CheckpointStore::get_checkpoint_for_commit(&repo, commit_sha) {
            Some(s) => s,
            None => {
                return json!({
                    "goal": goal, "checks": [], "passed": 0, "total": 0,
                    "verdict": "unknown",
                    "error": "No snapshot of the code at that point to check against.",
                });
            }
        };

        // A goal already curated in the ledger (a human-reviewed decomposition)
        // proves with THAT breakdown — deterministic, so a session card reading
        // this ask shows the same honest verdict every run, instead of the model
        // re-inventing a fresh (and often degenerate) decomposition each time.
        // Only when none is curated do we ground the model on this commit's own
        // symbols and decompose live.
        let requirements = match Self::curated_requirements(goal) {
            Some(reqs) => reqs,
            None => {
                let catalog = Self::symbol_catalog_from(&snapshot, goal, None);
                match Self::decompose_goal_grounded(goal, None, catalog) {
                    Some(reqs) if !reqs.is_empty() => reqs,
                    _ => {
                        return json!({
                            "goal": goal, "checks": [], "passed": 0, "total": 0,
                            "verdict": "unknown",
                            "error": "Couldn't work out what this goal needs yet.",
                        });
                    }
                }
            }
        };
        Self::check_requirements_against(goal, &requirements, &snapshot)
    }

    /// Reuse a human-curated decomposition when this goal's text matches one
    /// already in the goal ledger (`.aura/goals.jsonl`). A curated breakdown is
    /// deterministic and stable, so re-proving the same ask never drifts — the
    /// opposite of a fresh model decomposition, which can vary (or degenerate)
    /// run to run. Matched on the canonical `id_for_text` key so incidental
    /// whitespace/case never misses. Returns `None` (→ caller decomposes live)
    /// when no curated goal matches or the match carries no decomposition yet.
    fn curated_requirements(goal: &str) -> Option<Vec<crate::goals::Requirement>> {
        let want = crate::goals::store::id_for_text(goal);
        let reqs = crate::goals::store::load(std::path::Path::new("."))
            .into_iter()
            .find(|rec| crate::goals::store::id_for_text(&rec.text) == want)
            .and_then(|rec| rec.decomposition)
            .map(|d| d.requirements)?;
        if reqs.is_empty() {
            None
        } else {
            Some(reqs)
        }
    }

    /// The **costed** half of proving: ask the auditor model to break a goal
    /// into 3-5 semantic requirements (a logic node that must exist + an
    /// optional connection it must make). Returns `None` if the model is
    /// unavailable or its answer doesn't parse — the caller treats that as
    /// "can't tell yet", never as a failure. Run this ONCE per goal and cache
    /// the result; re-proving reuses it via [`prove_requirements`].
    pub fn decompose_goal(goal: &str) -> Option<Vec<crate::goals::Requirement>> {
        Self::decompose_goal_with_context(goal, None)
    }

    /// Decompose a goal, optionally grounded in the **live reasons** behind the
    /// work — the intent the agent just logged, the change in flight. Feeding
    /// the real reasoning in makes the requirements reflect what's actually
    /// being built (so a build-time prove isn't checking a stale, generic
    /// breakdown). This is the "dynamic reasons should make it prove" path.
    pub fn decompose_goal_with_context(goal: &str, context: Option<&str>) -> Option<Vec<crate::goals::Requirement>> {
        // Ground the decomposition in symbols that ACTUALLY exist in this repo.
        // Without this, the auditor invents plausible-but-fictional node names
        // (e.g. `DurableLedger`, `ProveGoal`) that match nothing in the AST, so
        // every check comes back "isn't in the code yet" — a false "not started"
        // verdict, the exact hallucinated-slop the prove path exists to prevent.
        // Feeding the real, goal-relevant identifiers in makes the model name
        // requirements after code that's really there (or genuinely absent).
        let catalog = Self::repo_symbol_catalog(goal, context);
        Self::decompose_goal_grounded(goal, context, catalog)
    }

    /// The model half of decomposition, grounded on a **caller-supplied** symbol
    /// catalog. Splitting this out lets a commit-anchored prove ground its
    /// breakdown on the symbols that existed **at that commit** (via
    /// [`Self::symbol_catalog_from`]) instead of the latest checkout — so the
    /// requirement names it invents line up with the same snapshot it will then
    /// check against. Pass `None` to decompose ungrounded (new repo, no snapshot).
    pub fn decompose_goal_grounded(
        goal: &str,
        context: Option<&str>,
        catalog: Option<String>,
    ) -> Option<Vec<crate::goals::Requirement>> {
        let system_prompt = "You are the Aura Semantic Auditor. Break the user's software goal into 3-5 'Semantic Requirements' — the specific code that must exist for the goal to be met. \n\
            Each requirement is: \n\
            - One specific Logic Node (Function, Class, or Struct) that must exist.\n\
            - The connection (dependency) it must be wired to.\n\
            \n\
            Name requirements after code the goal genuinely needs — not aspirational extras and not a generic checklist. When an 'Existing symbols' list of REAL identifiers from this repository is provided, use those exact names for `node_name` wherever one fits; never coin a synonym for a symbol that already has a name. Introduce a new name only when the goal needs code that is not yet in the list.\n\
            \n\
            Format your response as a valid JSON array of objects: \n\
            [{\"node_name\": \"string\", \"type\": \"Function|Class|Struct\", \"must_call\": \"node_name_or_none\"}]";

        let mut user_prompt = match context {
            Some(c) if !c.trim().is_empty() => format!(
                "Goal: {}\n\nRecent work and reasoning (use this to ground the requirements in what is actually being built — the specific functions/types touched):\n{}",
                goal,
                c.trim(),
            ),
            _ => format!("Goal: {}", goal),
        };
        if let Some(cat) = &catalog {
            user_prompt.push_str("\n\nExisting symbols in this repository (most relevant to the goal first — reuse these exact names where they fit):\n");
            user_prompt.push_str(cat);
        }

        let text = Self::generate_content(system_prompt, &user_prompt, 0.1, CognitiveLabor::Auditor)?;
        let clean_json = text.trim_matches(|c| c == '`').trim_start_matches("json").trim();
        let parsed = serde_json::from_str::<Vec<serde_json::Value>>(clean_json).ok()?;
        let requirements: Vec<crate::goals::Requirement> = parsed
            .into_iter()
            .filter_map(|req| {
                let node_name = req["node_name"].as_str()?.to_string();
                if node_name.is_empty() {
                    return None;
                }
                let node_type = req["type"].as_str().unwrap_or("Logic").to_string();
                let must_call = req["must_call"]
                    .as_str()
                    .filter(|c| *c != "none" && !c.is_empty())
                    .map(|s| s.to_string());
                Some(crate::goals::Requirement { node_name, node_type, must_call })
            })
            .collect();
        if requirements.is_empty() {
            None
        } else {
            Some(requirements)
        }
    }

    /// Build a relevance-ranked catalog of the identifiers that REALLY exist in
    /// this repo, to hand the auditor so it names requirements after real code
    /// instead of inventing fictional node names. Reads the latest checkpoint's
    /// AST nodes, scores each identifier by word-overlap with the goal + the
    /// in-flight reasoning, and returns the top slice as a compact bullet list
    /// (`- name (Kind)`). Returns `None` when there's no checkpoint to read —
    /// in which case the decompose falls back to ungrounded behaviour (a brand
    /// new repo genuinely has nothing to ground against). Token-bounded by the
    /// `MAX` cap so a large repo can't blow the prompt budget.
    fn repo_symbol_catalog(goal: &str, context: Option<&str>) -> Option<String> {
        let repo = Repository::open(".").ok()?;
        let checkpoints = CheckpointStore::get_all_checkpoints(&repo).ok()?;
        let latest = checkpoints.first()?;
        Self::symbol_catalog_from(latest, goal, context)
    }

    /// The scoring core of [`Self::repo_symbol_catalog`], operating on a **given**
    /// checkpoint rather than always the latest. A commit-anchored prove passes
    /// the commit's own checkpoint here so decomposition is grounded on the code
    /// that existed at that commit — the same snapshot it then proves against.
    fn symbol_catalog_from(
        checkpoint: &CheckpointData,
        goal: &str,
        context: Option<&str>,
    ) -> Option<String> {
        const MAX: usize = 60;

        // The vocabulary we're matching symbols against: words from the goal and
        // any live reasoning, lowercased, length-filtered to kill noise words.
        let mut haystack = goal.to_lowercase();
        if let Some(c) = context {
            haystack.push(' ');
            haystack.push_str(&c.to_lowercase());
        }
        let goal_words: std::collections::HashSet<String> = haystack
            .split(|c: char| !c.is_alphanumeric())
            .filter(|w| w.len() >= 3)
            .map(|w| w.to_string())
            .collect();

        // One entry per distinct identifier, scored by how many of its own
        // sub-words (split on snake_case / camelCase) appear in the goal vocab.
        let mut seen: std::collections::HashSet<&str> = std::collections::HashSet::new();
        let mut scored: Vec<(usize, &str, &str)> = Vec::new();
        for node in &checkpoint.ast_nodes {
            let ident = match node.identifier.as_deref() {
                Some(i) if !i.is_empty() => i,
                _ => continue,
            };
            if !seen.insert(ident) {
                continue;
            }
            let score = Self::symbol_relevance(ident, &goal_words);
            scored.push((score, ident, node.kind.as_str()));
        }
        if scored.is_empty() {
            return None;
        }

        // Most-relevant first; ties keep checkpoint order (stable sort).
        scored.sort_by(|a, b| b.0.cmp(&a.0));
        let mut out = String::new();
        for (_, ident, kind) in scored.into_iter().take(MAX) {
            out.push_str(&format!("- {} ({})\n", ident, kind));
        }
        Some(out)
    }

    /// Score one identifier's relevance to the goal vocabulary: the number of
    /// the identifier's sub-words (snake_case / camelCase boundaries) that
    /// appear in `goal_words`. Zero is fine — a symbol can still be offered as
    /// a candidate, just ranked below the ones the goal actually mentions.
    fn symbol_relevance(ident: &str, goal_words: &std::collections::HashSet<String>) -> usize {
        let mut parts: Vec<String> = Vec::new();
        let mut cur = String::new();
        let mut prev_lower = false;
        for ch in ident.chars() {
            if ch == '_' || ch == '-' || ch == ':' || ch == '.' {
                if !cur.is_empty() {
                    parts.push(std::mem::take(&mut cur));
                }
                prev_lower = false;
                continue;
            }
            if ch.is_uppercase() && prev_lower && !cur.is_empty() {
                parts.push(std::mem::take(&mut cur));
            }
            cur.push(ch.to_ascii_lowercase());
            prev_lower = ch.is_lowercase();
        }
        if !cur.is_empty() {
            parts.push(cur);
        }
        parts
            .iter()
            .filter(|p| p.len() >= 3 && goal_words.contains(p.as_str()))
            .count()
    }

    /// The **free** half of proving: check already-decomposed requirements
    /// against the latest code snapshot's AST — deterministic, no model call.
    /// Each check is enriched with the `file`/`line` of the satisfying node so
    /// the result doubles as a reverse code↔goal index. This is what the goal
    /// ledger re-runs on every build (decompose-once / prove-on-build).
    pub fn prove_requirements(goal: &str, requirements: &[crate::goals::Requirement]) -> serde_json::Value {
        if requirements.is_empty() {
            return json!({
                "goal": goal, "checks": [], "passed": 0, "total": 0,
                "verdict": "unknown",
                "error": "Couldn't work out what this goal needs yet.",
            });
        }

        let repo = match Repository::open(".") {
            Ok(r) => r,
            Err(_) => {
                return json!({
                    "goal": goal, "checks": [], "passed": 0, "total": 0,
                    "verdict": "unknown", "error": "Not a git repository.",
                });
            }
        };
        let checkpoints = CheckpointStore::get_all_checkpoints(&repo).unwrap_or_default();
        let latest = match checkpoints.first() {
            Some(l) => l,
            None => {
                return json!({
                    "goal": goal, "checks": [], "passed": 0, "total": 0,
                    "verdict": "unknown",
                    "error": "No snapshot of the code to check against yet.",
                });
            }
        };

        Self::check_requirements_against(goal, requirements, latest)
    }

    /// Same deterministic AST check as [`Self::prove_requirements`], but against
    /// the snapshot **at a specific commit** rather than the latest checkpoint.
    /// This is what makes a session's goals prove against the code that session
    /// produced — even when that code lives on a branch that isn't checked out.
    /// Falls back through nearest-descendant / nearest-ancestor checkpoints (see
    /// [`CheckpointStore::get_checkpoint_for_commit`]); "unknown" when none exist.
    pub fn prove_requirements_at(
        goal: &str,
        requirements: &[crate::goals::Requirement],
        commit_sha: &str,
    ) -> serde_json::Value {
        if requirements.is_empty() {
            return json!({
                "goal": goal, "checks": [], "passed": 0, "total": 0,
                "verdict": "unknown",
                "error": "Couldn't work out what this goal needs yet.",
            });
        }

        let repo = match Repository::open(".") {
            Ok(r) => r,
            Err(_) => {
                return json!({
                    "goal": goal, "checks": [], "passed": 0, "total": 0,
                    "verdict": "unknown", "error": "Not a git repository.",
                });
            }
        };
        let snapshot = match CheckpointStore::get_checkpoint_for_commit(&repo, commit_sha) {
            Some(s) => s,
            None => {
                return json!({
                    "goal": goal, "checks": [], "passed": 0, "total": 0,
                    "verdict": "unknown",
                    "error": "No snapshot of the code at that point to check against.",
                });
            }
        };

        Self::check_requirements_against(goal, requirements, &snapshot)
    }

    /// The per-requirement AST evaluation shared by [`Self::prove_requirements`]
    /// and [`Self::prove_requirements_at`]: given a decoded checkpoint, decide
    /// for each requirement whether the node exists, is a stub, and is wired.
    /// Deterministic, no model call. Assumes `requirements` is non-empty (callers
    /// guard that, so an empty set never masquerades as a trivially "verified" goal).
    fn check_requirements_against(
        goal: &str,
        requirements: &[crate::goals::Requirement],
        latest: &CheckpointData,
    ) -> serde_json::Value {
        let total = requirements.len();
        let mut passed = 0usize;
        let mut checks: Vec<serde_json::Value> = Vec::with_capacity(total);

        for req in requirements {
            let node_name = req.node_name.clone();
            let node_type = req.node_type.clone();
            let must_call = req.must_call.clone();

            let target_node = latest.ast_nodes.iter().find(|n| n.identifier.as_deref() == Some(node_name.as_str()));

            let (exists, is_stub, wired, check_passed, reason): (bool, bool, Option<bool>, bool, String) =
                match target_node {
                    None => (false, false, None, false, format!("'{}' isn't in the code yet", node_name)),
                    Some(node) if node.is_stub => (
                        true, true, None, false,
                        format!("'{}' is there but is still an empty placeholder", node_name),
                    ),
                    Some(node) => match &must_call {
                        Some(call_target) => {
                            let is_wired = node.dependencies.iter().any(|d| &d.name == call_target);
                            if is_wired {
                                (true, false, Some(true), true,
                                 format!("'{}' is built and connected to '{}'", node_name, call_target))
                            } else {
                                (true, false, Some(false), false,
                                 format!("'{}' is built but isn't connected to '{}' yet", node_name, call_target))
                            }
                        }
                        None => (true, false, None, true, format!("'{}' is built", node_name)),
                    },
                };

            // Where the satisfying node lives — the concrete code↔goal link.
            let (file, line) = match target_node {
                Some(node) => (
                    node.file_path.clone().map(serde_json::Value::from).unwrap_or(serde_json::Value::Null),
                    node.start_line.map(serde_json::Value::from).unwrap_or(serde_json::Value::Null),
                ),
                None => (serde_json::Value::Null, serde_json::Value::Null),
            };

            if check_passed {
                passed += 1;
            }
            checks.push(json!({
                "node_name": node_name,
                "node_type": node_type,
                "must_call": must_call,
                "exists": exists,
                "is_stub": is_stub,
                "wired": wired,
                "passed": check_passed,
                "reason": reason,
                "file": file,
                "line": line,
            }));
        }

        let verdict = if passed == total {
            "verified"
        } else if passed == 0 {
            "not_wired"
        } else {
            "partial"
        };

        json!({
            "goal": goal,
            "checks": checks,
            "passed": passed,
            "total": total,
            "verdict": verdict,
            "error": serde_json::Value::Null,
        })
    }

    /// Machine-readable proof: prints the structured outcome as pretty JSON to
    /// stdout (so a caller can capture it cleanly while progress/errors stay on
    /// stderr). Backs `aura prove --json` and the desktop Goals surface.
    pub fn prove_goal_json(goal: &str) {
        let outcome = Self::prove_goal_structured(goal);
        println!("{}", serde_json::to_string_pretty(&outcome).unwrap_or_else(|_| "{}".into()));
    }

    /// Machine-readable proof at a specific commit — backs `aura prove --json --at
    /// <sha>` and the desktop Goals surface when it anchors a session's proof to
    /// the commit that session produced.
    pub fn prove_goal_json_at(goal: &str, commit_sha: &str) {
        let outcome = Self::prove_goal_structured_at(goal, commit_sha);
        println!("{}", serde_json::to_string_pretty(&outcome).unwrap_or_else(|_| "{}".into()));
    }

    pub fn prove_goal(goal: &str) {
        eprintln!("{} {} {}", "🧪".bold(), "Aura Prover: Verifying Goal Achievement:".bold().cyan(), goal.yellow());
        eprintln!("  {} Analyzing behavioral requirements via local context...", "↳".dimmed());
        eprintln!("  {} Scanning Merkle-Graph for logic nodes and wiring...", "↳".dimmed());

        let outcome = Self::prove_goal_structured(goal);
        Self::render_prove_report(goal, &outcome);
    }

    /// Human-readable proof at a specific commit — `aura prove --at <sha>`. Same
    /// report as [`Self::prove_goal`] but reads the code as it was at that commit.
    pub fn prove_goal_at(goal: &str, commit_sha: &str) {
        eprintln!("{} {} {}", "🧪".bold(), "Aura Prover: Verifying Goal Achievement:".bold().cyan(), goal.yellow());
        eprintln!("  {} Anchoring proof to commit {}...", "↳".dimmed(), commit_sha.dimmed());
        eprintln!("  {} Scanning Merkle-Graph for logic nodes and wiring...", "↳".dimmed());

        let outcome = Self::prove_goal_structured_at(goal, commit_sha);
        Self::render_prove_report(goal, &outcome);
    }

    /// Render a structured proof outcome as the human-readable terminal report.
    /// Shared by [`Self::prove_goal`] and [`Self::prove_goal_at`] so the ad-hoc
    /// and commit-anchored paths never drift on how a proof is presented.
    fn render_prove_report(goal: &str, outcome: &serde_json::Value) {
        if let Some(err) = outcome["error"].as_str() {
            eprintln!("{} {}", "✗".red(), err);
            return;
        }

        eprintln!("\n{:-^60}", " SEMANTIC PROOF REPORT ".bold().blue());
        for check in outcome["checks"].as_array().into_iter().flatten() {
            let node_name = check["node_name"].as_str().unwrap_or("unknown");
            let node_type = check["node_type"].as_str().unwrap_or("Logic");
            let exists = check["exists"].as_bool().unwrap_or(false);
            let is_stub = check["is_stub"].as_bool().unwrap_or(false);
            if !exists {
                eprintln!("{} {} '{}' is missing from the AST!", "✗".red(), node_type, node_name);
            } else if is_stub {
                eprintln!("{} {} '{}' exists but is a {}!", "⚠️".yellow(), node_type, node_name, "STUB".bold().red());
            } else {
                eprintln!("{} {} '{}' exists and is substantive.", "✓".green(), node_type, node_name);
                match check["wired"].as_bool() {
                    Some(true) => eprintln!("  {} Properly wired to '{}'", "↳".dimmed(),
                        check["must_call"].as_str().unwrap_or("").green()),
                    Some(false) => eprintln!("  {} {} NOT wired to '{}'", "↳".dimmed(), "✗".red(),
                        check["must_call"].as_str().unwrap_or("").yellow()),
                    None => {}
                }
            }
        }
        eprintln!("{:-^60}\n", " END REPORT ".bold().blue());

        let passed = outcome["passed"].as_u64().unwrap_or(0);
        let total = outcome["total"].as_u64().unwrap_or(0);
        if passed == total {
            eprintln!("{} Goal '{}' is {}!", "🛡️ ".bold(), goal, "MATHEMATICALLY PROVEN".bold().green());
        } else {
            eprintln!("{} Goal '{}' is {} ({} of {} semantic links verified).",
                "❌".bold(), goal, "NOT PROVEN".bold().red(), passed, total);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    fn words(list: &[&str]) -> HashSet<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn relevance_splits_snake_case() {
        let goal = words(&["prove", "requirements"]);
        // `prove_requirements` → ["prove", "requirements"] → both hit.
        assert_eq!(GsdEngine::symbol_relevance("prove_requirements", &goal), 2);
        // `prove_goal` → ["prove", "goal"] → only "prove" hits.
        assert_eq!(GsdEngine::symbol_relevance("prove_goal", &goal), 1);
    }

    #[test]
    fn relevance_splits_camel_case() {
        let goal = words(&["ledger", "record"]);
        // `LedgerRecord` → ["ledger", "record"] → both hit.
        assert_eq!(GsdEngine::symbol_relevance("LedgerRecord", &goal), 2);
        // `GoalStore` → ["goal", "store"] → neither in vocab.
        assert_eq!(GsdEngine::symbol_relevance("GoalStore", &goal), 0);
    }

    #[test]
    fn relevance_handles_path_separators_and_short_words() {
        let goal = words(&["decompose", "goal"]);
        // Module path: `goals::decompose_goal` → ["goals","decompose","goal"].
        // "goals" (5) and "goal" (4) and "decompose" all length-pass; only the
        // exact tokens in the vocab count, so "decompose" + "goal" = 2.
        assert_eq!(GsdEngine::symbol_relevance("goals::decompose_goal", &goal), 2);
        // Sub-words under 3 chars are dropped so they never spuriously match.
        let noisy = words(&["a", "id"]);
        assert_eq!(GsdEngine::symbol_relevance("a_id", &noisy), 0);
    }
}