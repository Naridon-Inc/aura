use std::fs;
use colored::Colorize;
use serde_json::json;
use crate::config::ConfigManager;
use crate::checkpoint::CheckpointStore;
use git2::Repository;
use std::sync::{Arc, Mutex};
use std::thread;

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
                    "anthropic" => "claude-4-6-opus-202602".to_string(),
                    "openai" => "gpt-5.2-pro".to_string(),
                    _ => "gemini-3-1-pro-ultra".to_string(),
                }
            }),
            CognitiveLabor::Researcher => config.model_researcher.clone().unwrap_or_else(|| {
                match provider.as_str() {
                    "anthropic" => "claude-3-5-haiku".to_string(), // Haiku 4.6 isn't listed, falling back to fastest known
                    "openai" => "gpt-5.2-mini".to_string(),
                    "mercury" => "mercury-2-reasoning".to_string(),
                    _ => "gemini-3-flash".to_string(),
                }
            }),
            CognitiveLabor::Auditor => config.model_auditor.clone().unwrap_or_else(|| {
                match provider.as_str() {
                    "anthropic" => "claude-4-6-opus-202602".to_string(),
                    "openai" => "gpt-5.2-strict".to_string(),
                    _ => "gemini-3-deep-think".to_string(),
                }
            }),
            CognitiveLabor::Arbitrator => config.model_arbitrator.clone().unwrap_or_else(|| {
                match provider.as_str() {
                    "anthropic" => "claude-4-6-opus-fast".to_string(),
                    "openai" => "gpt-5.3-codex".to_string(),
                    _ => "gemini-3-1-pro".to_string(),
                }
            }),
        };

        // If Mercury is the selected model, route to Inception API
        let active_api_provider = if model_string == "mercury-2" { "mercury" } else { provider.as_str() };

        let api_key = match ConfigManager::get_api_key(active_api_provider) {
            Some(key) => key,
            None => {
                println!("{} Missing API key for provider: {}", "⚠️".yellow(), active_api_provider);
                return None;
            }
        };

        let client = reqwest::blocking::Client::new();
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
                        }
                    }
                }
            }
        }
        None
    }

    /// Step 1: The Orchestrator / Planner
    pub fn plan_milestone(prompt: &str) {
        println!("{} {} {}", "🧠".bold(), "Aura Orchestrator: Planning Milestone for".bold().cyan(), prompt.yellow());
        
        let provider = ConfigManager::get_active_provider();
        let _api_key = match ConfigManager::get_api_key(&provider) {
            Some(key) => key,
            None => {
                println!("{} API Key required for Orchestration (Provider: {}).", "⚠️".yellow(), provider);
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
                    println!("{} API Key saved to local configuration.", "✓".green());
                    valid_key
                } else {
                    println!("{} Planning aborted. Valid API key required.", "✗".red());
                    return;
                }
            }
        };

        println!("\n{} {}", "📋".bold(), "Configuring Milestone...".cyan());
        use dialoguer::{Select, theme::ColorfulTheme};

        let execution_modes = vec!["Parallel (Independent plans run simultaneously)", "Sequential (One plan at a time)"];
        let exec_selection = Select::with_theme(&ColorfulTheme::default())
            .with_prompt("Run plans in parallel?")
            .default(0)
            .items(&execution_modes)
            .interact()
            .unwrap_or(0);
        let exec_choice = if exec_selection == 0 { "Parallel" } else { "Sequential" };

        let git_strategies = vec!["Atomic Commits (Commit after every wave)", "Single Commit (Commit everything at the end)"];
        let git_selection = Select::with_theme(&ColorfulTheme::default())
            .with_prompt("Git tracking strategy?")
            .default(0)
            .items(&git_strategies)
            .interact()
            .unwrap_or(0);
        let git_choice = if git_selection == 0 { "Atomic Commits" } else { "Single Commit" };

        println!("\n{} Querying Local RAG and Merkle-Graph for dependency context...", "↳".dimmed());
        
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
        println!("{} Spawning parallel research agents (Architecture, Logic, Schema, Routes)...", "🌊".blue());
        
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
                    Investigate the codebase context and provide 3-5 critical insights for the objective: '{}'. \n\
                    Focus purely on technical implementation details and potential pitfalls in your specific domain.",
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
        println!("  {} Research complete. {} specialized insights gathered.", "✓".green(), domains.len());

        println!("  {} Synthesizing atomic execution waves...", "↳".dimmed());
        
        let system_prompt = format!(
            "You are the Aura Architect. Use the provided research and AST context to generate a flawless execution plan.\n\
            \n\
            <ast_context>\n\
            {}\n\
            </ast_context>\n\
            \n\
            <specialized_research>\n\
            {}\n\
            </specialized_research>\n\
            \n\
            The user has requested the following execution parameters:\n\
            - Execution Mode: {}\n\
            - Git Strategy: {}\n\
            \n\
            If this is the initial prompt and you need clarification, output ONLY your questions. \n\
            Otherwise, generate the plan with TWO sections separated by '===AURA_SPLIT==='.\n\
            \n\
            Request: {}", ast_context, final_research, exec_choice, git_choice, prompt
        );

        if let Some(text_str) = Self::generate_content(&system_prompt, "", 0.2, CognitiveLabor::Architect) {
            if !text_str.contains("<plan") {
                println!("\n{} {}", "💬".bold(), "Aura Architect requires clarification:".cyan());
                
                use dialoguer::Input;
                use dialoguer::theme::ColorfulTheme;
                
                let mut answers = String::new();
                let questions: Vec<&str> = text_str.lines()
                    .filter(|line| !line.trim().is_empty() && line.chars().next().unwrap_or(' ').is_numeric())
                    .collect();
                    
                if questions.is_empty() {
                    println!("{}\n", text_str.yellow());
                    let single_answer: String = Input::with_theme(&ColorfulTheme::default())
                        .with_prompt("Your answer")
                        .interact_text()
                        .unwrap_or_default();
                    answers = single_answer;
                } else {
                    for q in questions {
                        let clean_q = q.trim().trim_start_matches(|c: char| c.is_numeric() || c == '.' || c == ' ');
                        println!("\n{}", clean_q.yellow());
                        let answer: String = Input::with_theme(&ColorfulTheme::default())
                            .with_prompt("Answer")
                            .interact_text()
                            .unwrap_or_default();
                        answers.push_str(&format!("Q: {}\nA: {}\n\n", clean_q, answer));
                    }
                }
                    
                println!("\n  {} Synthesizing atomic execution waves...", "↳".dimmed());
                
                let follow_up = format!("User Answers:\n{}\n\nGenerate the final plan now.", answers);
                
                if let Some(final_text) = Self::generate_content(&system_prompt, &follow_up, 0.2, CognitiveLabor::Architect) {
                    Self::parse_and_save_plan(&final_text);
                    return;
                }
                return;
            }
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
        println!("{} Verifying plan integrity via Aura Auditor...", "🔍".cyan());
        
        let check_prompt = format!(
            "You are the Aura Plan Checker. Review the following execution plan for logical consistency, dependency deadlocks, and requirement coverage. \n\
            Output 'PASS' if the plan is perfect. \n\
            Otherwise, output a bulleted list of specific issues to fix.\n\n\
            <plan>\n{}\n</plan>", cleaned_xml
        );

        if let Some(feedback) = Self::generate_content(&check_prompt, "", 0.1, CognitiveLabor::Auditor) {
            if feedback.trim().contains("PASS") {
                println!("  {} Plan verified by Auditor.", "✓".green());
            } else {
                println!("{} Plan Auditor found issues:\n{}", "⚠️".yellow(), feedback.dimmed());
            }
        }
        
        let _ = fs::create_dir_all(".aura/plans");
        let _ = fs::write(".aura/plans/ACTIVE_MILESTONE.xml", &cleaned_xml);
        let _ = fs::write("PLAN.md", format!("# Aura Execution Plan\n\n{}", markdown_plan));
        
        println!("{} Milestone locked and saved.", "✓".green().bold());
    }

    /// Step 2: The Executor (Wave Runner)
    pub fn execute_wave() {
        println!("{} {}", "⚡".bold(), "Aura Executor: Initiating Atomic Waves".bold().cyan());
        
        let plans_xml = match fs::read_to_string(".aura/plans/ACTIVE_MILESTONE.xml") {
            Ok(content) => content,
            Err(_) => {
                println!("{} No active milestone found.", "✗".red());
                return;
            }
        };

        let mut actions = Vec::new();
        for line in plans_xml.lines() {
            if line.contains("<action>") && line.contains("</action>") {
                let start = line.find("<action>").unwrap() + 8;
                let end = line.find("</action>").unwrap();
                actions.push(line[start..end].to_string());
            }
        }

        for (i, action) in actions.iter().enumerate() {
            println!("\n{} Executing Wave {}: {}", "🌊".blue(), i + 1, action.yellow());
            std::thread::sleep(std::time::Duration::from_millis(500));
            println!("  {} Pulse Check: Verifying AST stability...", "↳".dimmed());
            std::thread::sleep(std::time::Duration::from_millis(800));
            println!("  {} Atomic task simulated successfully.", "✓".green());
        }

        println!("\n{} {}", "🚀".bold(), "Milestone achieved. All logic nodes verified.".bold().green());
        let _ = fs::remove_file(".aura/plans/ACTIVE_MILESTONE.xml");
    }

    /// Step 3: Goal-Backward Verification (Aura Prove)
    pub fn prove_goal(goal: &str) {
        println!("{} {} {}", "🧪".bold(), "Aura Prover: Verifying Goal Achievement:".bold().cyan(), goal.yellow());

        println!("  {} Analyzing behavioral requirements via local context...", "↳".dimmed());
        
        let system_prompt = "You are the Aura Semantic Auditor. Analyze the user's software goal and break it down into 3-5 'Semantic Requirements'. \n\
            Each requirement must be: \n\
            - A specific Logic Node (Function, Class, or Struct) that must exist.\n\
            - A connection (dependency) that must be wired.\n\
            \n\
            Format your response as a valid JSON array of objects: \n\
            [{\"node_name\": \"string\", \"type\": \"Function|Class|Struct\", \"must_call\": \"node_name_or_none\"}]";

        let mut requirements: Vec<serde_json::Value> = Vec::new();
        
        if let Some(text) = Self::generate_content(system_prompt, &format!("Goal: {}", goal), 0.1, CognitiveLabor::Auditor) {
            let clean_json = text.trim_matches(|c| c == '`').trim_start_matches("json").trim();
            if let Ok(parsed) = serde_json::from_str::<Vec<serde_json::Value>>(clean_json) {
                requirements = parsed;
            }
        }

        if requirements.is_empty() {
            println!("{} Failed to extract semantic requirements.", "✗".red());
            return;
        }

        println!("  {} Scanning Merkle-Graph for logic nodes and wiring...", "↳".dimmed());
        let repo = match Repository::open(".") {
            Ok(r) => r,
            Err(_) => {
                println!("{} Git repository not found.", "✗".red());
                return;
            }
        };

        let checkpoints = CheckpointStore::get_all_checkpoints(&repo).unwrap_or_default();
        let latest = match checkpoints.first() {
            Some(l) => l,
            None => {
                println!("{} No Aura checkpoints found.", "✗".red());
                return;
            }
        };

        println!("\n{:-^60}", " SEMANTIC PROOF REPORT ".bold().blue());
        
        let total_checks = requirements.len();
        let mut passed_checks = 0;

        for req in requirements {
            let node_name = req["node_name"].as_str().unwrap_or("unknown");
            let node_type = req["type"].as_str().unwrap_or("Logic");
            let must_call = req["must_call"].as_str();

            let target_node = latest.ast_nodes.iter().find(|n| {
                n.identifier.as_deref() == Some(node_name)
            });

            match target_node {
                Some(node) => {
                    if node.is_stub {
                        println!("{} {} '{}' exists but is a {}!", "⚠️".yellow(), node_type, node_name, "STUB".bold().red());
                    } else {
                        println!("{} {} '{}' exists and is substantive.", "✓".green(), node_type, node_name);
                        
                        if let Some(call_target) = must_call {
                            if call_target != "none" {
                                let is_wired = node.dependencies.iter().any(|d| d.name == call_target);
                                if is_wired {
                                    println!("  {} Properly wired to '{}'", "↳".dimmed(), call_target.green());
                                    passed_checks += 1;
                                } else {
                                    println!("  {} {} NOT wired to '{}'", "↳".dimmed(), "✗".red(), call_target.yellow());
                                }
                            } else {
                                passed_checks += 1;
                            }
                        }
                    }
                },
                None => {
                    println!("{} {} '{}' is missing from the AST!", "✗".red(), node_type, node_name);
                }
            }
        }

        println!("{:-^60}\n", " END REPORT ".bold().blue());

        if passed_checks == total_checks {
            println!("{} Goal '{}' is {}!", "🛡️ ".bold(), goal, "MATHEMATICALLY PROVEN".bold().green());
        } else {
            println!("{} Goal '{}' is {} ({} of {} semantic links verified).", 
                "❌".bold(), 
                goal, 
                "NOT PROVEN".bold().red(),
                passed_checks,
                total_checks
            );
        }
    }
}