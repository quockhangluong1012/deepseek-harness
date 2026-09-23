<!-- 英文源文件由 scripts/gen-doc-graphs.ts 生成；本中文文件是通过双语配对维护的经评审对侧。
     更新时先运行 `pnpm run gen-doc-graphs` 更新英文，再更新本文件并运行 `pnpm run verify-translation-pairing --write docs/capability-seams.md` 重新记录配对。 -->

# 能力 Seams 与核心服务

[English](capability-seams.md) | 中文

服务可以是核心主干服务、可替换的能力 seam、组合包／组合点或独立服务。下图展示了拥有服务声明的包、已知实现包，以及直接消费该服务的包。

```mermaid
flowchart LR
  pkg_agent_kernel["agent-kernel"]
  svc_agentKernel["ctx.agentKernel<br/>Task contract, action ledger, and completion gate"]
  pkg_agent_context["agent-context"]
  svc_agentContext["ctx.agentContext<br/>Compiled context provenance"]
  pkg_hmr["hmr"]
  svc_hmr["ctx.hmr<br/>Serialized module and configuration reloads"]
  pkg_app_boot["app-boot"]
  pkg_client_ui_plugin_manager["client-ui-plugin-manager"]
  svc_pluginRegistryProbe["ctx.pluginRegistryProbe<br/>Host registry response comparison"]
  pkg_plugin_manager["plugin-manager"]
  svc_pluginManager["ctx.pluginManager<br/>Current-profile plugin and bundle management"]
  pkg_ui_settings_plugin_inventory["ui-settings-plugin-inventory"]
  svc_profileContext["ctx.profileContext<br/>Launcher-owned profile data"]
  pkg_client_connection["client-connection"]
  svc_connection["ctx.connection<br/>Authenticated browser transport"]
  pkg_api_gateway["api-gateway"]
  pkg_host_frontend_static["host-frontend-static"]
  pkg_mcp_resources["mcp-resources"]
  svc_mcpResources["ctx.mcpResources<br/>Scoped MCP resource access"]
  pkg_mcp_client["mcp-client"]
  pkg_browser_use["browser-use"]
  svc_browserUse["ctx.browserUse<br/>Browser-use provider registration"]
  pkg_experimental_browser_use_playwright_mcp["experimental-browser-use-playwright-mcp"]
  pkg_experimental_browser_use_chrome_devtools_mcp["experimental-browser-use-chrome-devtools-mcp"]
  pkg_experimental_browser_use_stagehand_native["experimental-browser-use-stagehand-native"]
  pkg_computer_use["computer-use"]
  svc_computerUse["ctx.computerUse<br/>Computer-use provider registration"]
  pkg_experimental_computer_use_cua_driver_mcp["experimental-computer-use-cua-driver-mcp"]
  pkg_experimental_computer_use_cua_driver_native["experimental-computer-use-cua-driver-native"]
  pkg_office_to_pdf["office-to-pdf"]
  svc_officeToPdf["ctx.officeToPdf<br/>Office to PDF conversion"]
  pkg_client_ui_sidebar_documentpreview["client-ui-sidebar-documentpreview"]
  pkg_attachment["attachment"]
  svc_attachments["ctx.attachments<br/>Durable binary attachment storage"]
  pkg_attachment_local["attachment-local"]
  pkg_api_session_controller["api-session-controller"]
  pkg_tool_fs["tool-fs"]
  pkg_llm_pi_ai["llm-pi-ai"]
  pkg_llm_deepseek["llm-deepseek"]
  pkg_client_file_upload["client-file-upload"]
  svc_fileUploads["ctx.fileUploads<br/>Agent-scoped staged file uploads"]
  pkg_embeddings["embeddings"]
  svc_embeddings["ctx.embeddings<br/>Embedding provider registry"]
  pkg_embeddings_http["embeddings-http"]
  pkg_llm["llm"]
  svc_llm["ctx.llm<br/>LLM adapter registry"]
  pkg_llm_replay["llm-replay"]
  pkg_agent_loop["agent-loop"]
  pkg_compaction_basic["compaction-basic"]
  pkg_deepseek_llm_api_extensions["deepseek-llm-api-extensions"]
  svc_deepseekLlmApiExtensions["ctx.deepseekLlmApiExtensions<br/>Official DeepSeek request extensions"]
  pkg_session_log_deepseek["session-log-deepseek"]
  pkg_plugin_package_inventory_deepseek["plugin-package-inventory-deepseek"]
  pkg_token_meter["token-meter"]
  svc_tokenMeter["ctx.tokenMeter<br/>Replay token measurement"]
  pkg_compaction_tool_result_pruner["compaction-tool-result-pruner"]
  svc_toolResultPruner["ctx.toolResultPruner<br/>Model-free tool-result pruning"]
  pkg_session["session"]
  svc_sessions["ctx.sessions<br/>In-memory session store"]
  pkg_agent["agent"]
  pkg_session_persistence["session-persistence"]
  pkg_session_query["session-query"]
  pkg_session_query_sqlite["session-query-sqlite"]
  pkg_subagent_in_process_driver["subagent-in-process-driver"]
  pkg_invariants["invariants"]
  pkg_message_feedback["message-feedback"]
  pkg_experimental_api_speech_to_text["experimental-api-speech-to-text"]
  svc_speechController["ctx.speechController<br/>Experimental transcription Remote"]
  svc_sessionController["ctx.sessionController<br/>Host Session Remote controller"]
  svc_sessionFileReferences["ctx.sessionFileReferences<br/>Session-addressed file-reference Remote adapter"]
  svc_sessionSkillCatalog["ctx.sessionSkillCatalog<br/>Session-addressed skill Remote adapter"]
  pkg_api_job_controller["api-job-controller"]
  svc_jobController["ctx.jobController<br/>Host job Remote controller"]
  pkg_api_settings_controller["api-settings-controller"]
  svc_credentialsController["ctx.credentialsController<br/>Host credential-surface Remote controller"]
  pkg_authorization_remote["authorization-remote"]
  svc_authorizationRemote["ctx.authorizationRemote<br/>Host authorization-surface Remote controller"]
  svc_settingsController["ctx.settingsController<br/>Host settings-surface Remote controller"]
  pkg_api_workspace_files["api-workspace-files"]
  svc_workspaceFiles["ctx.workspaceFiles<br/>Host workspace file Remote service"]
  pkg_workspace_changes["workspace-changes"]
  svc_workspaceChanges["ctx.workspaceChanges<br/>Host per-turn changed-file summaries"]
  pkg_api_terminal_controller["api-terminal-controller"]
  svc_terminalController["ctx.terminalController<br/>Session interactive terminal Remote controller"]
  pkg_api_workspace_controller["api-workspace-controller"]
  svc_workspaceController["ctx.workspaceController<br/>Host Workspace Remote controller"]
  svc_directoryPickerController["ctx.directoryPickerController<br/>Host directory-picking Remote controller"]
  svc_invariants["ctx.invariants<br/>Package-owned invariant registry"]
  pkg_scope["scope"]
  pkg_typert_registry["typert-registry"]
  svc_typert["ctx.typert<br/>Runtime type registry"]
  pkg_typert_loader["typert-loader"]
  svc_typertGateway["ctx.typertGateway<br/>Typert Host invocation gateway"]
  svc_sessionPersistence["ctx.sessionPersistence<br/>Durable session persistence seam"]
  pkg_session_persistence_jsonl["session-persistence-jsonl"]
  pkg_tool_bash["tool-bash"]
  pkg_hooks_claude_code["hooks-claude-code"]
  pkg_hooks_codex["hooks-codex"]
  pkg_config_editor["config-editor"]
  svc_configEditor["ctx.configEditor<br/>Profile configuration edits"]
  pkg_settings["settings"]
  pkg_agent_default_model["agent-default-model"]
  svc_settings["ctx.settings<br/>Plugin configuration forms"]
  pkg_tool_subagent["tool-subagent"]
  svc_subagentModelSelection["ctx.subagentModelSelection<br/>Subagent model-selection preference"]
  pkg_credentials["credentials"]
  svc_credentials["ctx.credentials<br/>Credential seam"]
  pkg_credentials_local["credentials-local"]
  pkg_deepseek_account["deepseek-account"]
  svc_deepseekAccount["ctx.deepseekAccount<br/>DeepSeek account"]
  pkg_deepseek_account_platform["deepseek-account-platform"]
  pkg_api_account_controller["api-account-controller"]
  pkg_authorization["authorization"]
  svc_authorization["ctx.authorization<br/>Authorization flow registry"]
  pkg_host_product_telemetry_otel["host-product-telemetry-otel"]
  svc_productTelemetry["ctx.productTelemetry<br/>Product usage event sender"]
  pkg_session_telemetry["session-telemetry"]
  svc_sessionTelemetry["ctx.sessionTelemetry<br/>Session telemetry seam"]
  pkg_session_telemetry_otel["session-telemetry-otel"]
  pkg_storage["storage"]
  svc_storage["ctx.storage<br/>Non-session storage hub"]
  pkg_storage_json["storage-json"]
  pkg_storage_sqlite["storage-sqlite"]
  pkg_storage_domain["storage-domain"]
  svc_storageDomain["ctx.storageDomain<br/>Domain data facility"]
  pkg_workspace["workspace"]
  svc_messageFeedback["ctx.messageFeedback<br/>Lifecycle-bound message feedback"]
  pkg_command_feedback["command-feedback"]
  svc_sessionFeedback["ctx.sessionFeedback<br/>Session-level feedback recorder"]
  svc_workspaceRegistry["ctx.workspaceRegistry<br/>Workspace entity registry"]
  pkg_active_memory_context["active-memory-context"]
  pkg_workspace_memory["workspace-memory"]
  svc_workspaceMemory["ctx.workspaceMemory<br/>Per-Workspace memory store"]
  pkg_workspace_memory_llm["workspace-memory-llm"]
  pkg_workspace_memory_context["workspace-memory-context"]
  pkg_client_ui_workspace_memory["client-ui-workspace-memory"]
  svc_workspaceMemoryExtractor["ctx.workspaceMemoryExtractor<br/>Workspace memory extractor"]
  svc_workspaceMemoryController["ctx.workspaceMemoryController<br/>Workspace memory Remote face"]
  svc_sessionQuery["ctx.sessionQuery<br/>Session reads, traces, filters, and search"]
  pkg_session_reference["session-reference"]
  pkg_tool_session_query["tool-session-query"]
  pkg_file_reference["file-reference"]
  svc_fileReferences["ctx.fileReferences<br/>File reference discovery"]
  pkg_file_reference_local["file-reference-local"]
  svc_sessionReferenceResolver["ctx.sessionReferenceResolver<br/>Cross-session snapshot preparation"]
  pkg_session_title["session-title"]
  svc_sessionTitle["ctx.sessionTitle<br/>Log-backed session titles"]
  pkg_session_title_first_prompt_llm["session-title-first-prompt-llm"]
  pkg_session_title_all_prompts_llm["session-title-all-prompts-llm"]
  pkg_system_prompt["system-prompt"]
  svc_systemPrompt["ctx.systemPrompt<br/>System prompt assembly registry"]
  pkg_tools["tools"]
  pkg_tool_terminal["tool-terminal"]
  pkg_tool_web["tool-web"]
  svc_tools["ctx.tools<br/>Tool registry and guarded execution pipeline"]
  pkg_tool_ask_user["tool-ask-user"]
  pkg_tool_cordis["tool-cordis"]
  pkg_tool_skill["tool-skill"]
  pkg_tool_todo["tool-todo"]
  pkg_user_questions["user-questions"]
  svc_userQuestions["ctx.userQuestions<br/>Human question/answer seam"]
  pkg_plan_mode["plan-mode"]
  svc_planMode["ctx.planMode<br/>Plan collaboration state"]
  pkg_agent_preset_registry["agent-preset-registry"]
  svc_agentPresets["ctx.agentPresets<br/>Per-session agent composition"]
  pkg_commands["commands"]
  svc_commands["ctx.commands<br/>Human command registry"]
  pkg_session_projection["session-projection"]
  svc_sessionProjections["ctx.sessionProjections<br/>Session projection units"]
  pkg_session_projection_cache["session-projection-cache"]
  svc_sessionProjectionCache["ctx.sessionProjectionCache<br/>Persisted projection cache"]
  pkg_subagent["subagent"]
  pkg_usage_ledger["usage-ledger"]
  svc_usageLedger["ctx.usageLedger<br/>Usage ledger fold"]
  pkg_client_ui_usage_dashboard["client-ui-usage-dashboard"]
  svc_usageDashboard["ctx.usageDashboard<br/>Usage dashboard Remote face"]
  pkg_skill["skill"]
  svc_skills["ctx.skills<br/>Skill provider registry"]
  pkg_skill_badge["skill-badge"]
  pkg_skill_filesystem["skill-filesystem"]
  pkg_skill_office["skill-office"]
  pkg_evolution_skill_telemetry["evolution-skill-telemetry"]
  svc_evolutionSkillTelemetry["ctx.evolutionSkillTelemetry<br/>Skill curation telemetry store"]
  pkg_evolution_skill_manage["evolution-skill-manage"]
  pkg_evolution_curator["evolution-curator"]
  pkg_evolution_memory["evolution-memory"]
  svc_evolutionMemory["ctx.evolutionMemory<br/>Per-scope evolution memory store"]
  pkg_evolution_reviewer["evolution-reviewer"]
  pkg_evolution_memory_context["evolution-memory-context"]
  pkg_command_evolution["command-evolution"]
  svc_evolutionReviewer["ctx.evolutionReviewer<br/>Background evolution reviewer"]
  svc_evolutionCurator["ctx.evolutionCurator<br/>Idle skill-lifecycle curator"]
  pkg_evolution_heartbeat["evolution-heartbeat"]
  svc_evolutionHeartbeat["ctx.evolutionHeartbeat<br/>Host-wide idle-triggered task registry"]
  pkg_evolution_feedback["evolution-feedback"]
  svc_evolutionFeedback["ctx.evolutionFeedback<br/>Per-session failure-observation store"]
  pkg_evolution_dreaming["evolution-dreaming"]
  svc_evolutionDreaming["ctx.evolutionDreaming<br/>Three-phase dreaming consolidation"]
  pkg_evolution_graph["evolution-graph"]
  svc_evolutionGraph["ctx.evolutionGraph<br/>Per-scope knowledge graph"]
  pkg_evolution_controller["evolution-controller"]
  svc_evolutionController["ctx.evolutionController<br/>Evolution scope Remote controller"]
  pkg_evolution_scorer["evolution-scorer"]
  svc_evolutionScorer["ctx.evolutionScorer<br/>Recorded-session improvement scorer"]
  pkg_evolution_optimizer["evolution-optimizer"]
  pkg_client_ui_evolution["client-ui-evolution"]
  svc_evolutionCuratorStatus["ctx.evolutionCuratorStatus<br/>Evolution curator-status Remote face"]
  pkg_evolution_curriculum["evolution-curriculum"]
  svc_evolutionCurriculum["ctx.evolutionCurriculum<br/>Automatic curriculum store"]
  pkg_evolution_benchmark["evolution-benchmark"]
  svc_evolutionBenchmark["ctx.evolutionBenchmark<br/>Benchmark task store"]
  pkg_evolution_evaluator_health["evolution-evaluator-health"]
  svc_evolutionEvaluatorHealth["ctx.evolutionEvaluatorHealth<br/>Evaluator ensemble health store"]
  pkg_evolution_population["evolution-population"]
  svc_evolutionPopulation["ctx.evolutionPopulation<br/>Population-based evolution store"]
  pkg_evolution_model_routes["evolution-model-routes"]
  svc_evolutionModelRoutes["ctx.evolutionModelRoutes<br/>Adaptive model-routing store"]
  pkg_evolution_canary["evolution-canary"]
  svc_evolutionCanary["ctx.evolutionCanary<br/>Shadow/canary deployment store"]
  pkg_evolution_novelty_search["evolution-novelty-search"]
  svc_evolutionNovelty["ctx.evolutionNovelty<br/>Novelty-search archive store"]
  pkg_evolution_stagnation["evolution-stagnation"]
  svc_evolutionStagnation["ctx.evolutionStagnation<br/>Stagnation detection store"]
  pkg_evolution_islands["evolution-islands"]
  svc_evolutionIslands["ctx.evolutionIslands<br/>Island evolution store"]
  pkg_evolution_self_model["evolution-self-model"]
  svc_evolutionSelfModel["ctx.evolutionSelfModel<br/>Controlled self-model store"]
  pkg_evolution_uncertainty["evolution-uncertainty"]
  svc_evolutionUncertainty["ctx.evolutionUncertainty<br/>Uncertainty-driven learning store"]
  pkg_evolution_adversary["evolution-adversary"]
  svc_evolutionAdversary["ctx.evolutionAdversary<br/>Adversarial evolution store"]
  pkg_evolution_lineage["evolution-lineage"]
  svc_evolutionLineage["ctx.evolutionLineage<br/>Dependency-aware lineage store"]
  pkg_evolution_sleeptime["evolution-sleeptime"]
  svc_evolutionSleeptime["ctx.evolutionSleeptime<br/>Sleep-time compute store"]
  pkg_evolution_budget["evolution-budget"]
  svc_evolutionBudget["ctx.evolutionBudget<br/>Evolution budget store"]
  pkg_evolution_evaluator_strategy["evolution-evaluator-strategy"]
  svc_evolutionEvaluatorStrategy["ctx.evolutionEvaluatorStrategy<br/>Evaluator-strategy store"]
  pkg_evolution_meta["evolution-meta"]
  svc_evolutionMeta["ctx.evolutionMeta<br/>Meta-evolution store"]
  pkg_evolution_metrics["evolution-metrics"]
  svc_evolutionMetrics["ctx.evolutionMetrics<br/>Evolution metric layer"]
  pkg_evolution_operators["evolution-operators"]
  svc_evolutionOperators["ctx.evolutionOperators<br/>Mutation-operator store"]
  pkg_evolution_router["evolution-router"]
  svc_evolutionRouter["ctx.evolutionRouter<br/>Routing self-optimization store"]
  pkg_evolution_trajectory["evolution-trajectory"]
  svc_evolutionTrajectory["ctx.evolutionTrajectory<br/>ShareGPT trajectory export service"]
  pkg_evolution_trace["evolution-trace"]
  svc_evolutionTrace["ctx.evolutionTrace<br/>Immutable session trace projection"]
  pkg_evolution_retrieval["evolution-retrieval"]
  svc_evolutionRetrieval["ctx.evolutionRetrieval<br/>Retrieval-configuration store"]
  pkg_evolution_verifiers["evolution-verifiers"]
  svc_evolutionVerifiers["ctx.evolutionVerifiers<br/>Verifier-first admission ladder"]
  svc_agents["ctx.agents<br/>Agent service"]
  pkg_acp["acp"]
  svc_agentDefaultModel["ctx.agentDefaultModel<br/>Default Agent model selection"]
  pkg_headless["headless"]
  svc_agentLoop["ctx.agentLoop<br/>Concrete loop driver"]
  pkg_base["base"]
  pkg_sdk_minimal["sdk-minimal"]
  pkg_goal["goal"]
  svc_goals["ctx.goals<br/>Same-session goal domain"]
  pkg_ssh["ssh"]
  svc_ssh["ctx.ssh<br/>POSIX SSH connection owner"]
  pkg_fs_ssh["fs-ssh"]
  pkg_subprocess_ssh["subprocess-ssh"]
  pkg_sandbox_ssh["sandbox-ssh"]
  pkg_subprocess["subprocess"]
  svc_subprocess["ctx.subprocess<br/>Subprocess seam"]
  pkg_subprocess_local["subprocess-local"]
  pkg_bash_local["bash-local"]
  pkg_bash_sandbox["bash-sandbox"]
  pkg_terminal_bash["terminal-bash"]
  pkg_lsp_stdio["lsp-stdio"]
  pkg_subagent_acp["subagent-acp"]
  pkg_subagent_codex["subagent-codex"]
  pkg_subagent_claude_code["subagent-claude-code"]
  pkg_shell["shell"]
  svc_shell["ctx.shell<br/>Bash executor seam"]
  pkg_pwsh_local["pwsh-local"]
  pkg_tool_pwsh["tool-pwsh"]
  pkg_shell_env["shell-env"]
  svc_shellEnv["ctx.shellEnv<br/>Managed bash environment registry"]
  pkg_terminal["terminal"]
  svc_terminals["ctx.terminals<br/>Persistent PTY session registry"]
  pkg_sandbox["sandbox"]
  svc_sandbox["ctx.sandbox<br/>Process-sandbox seam"]
  pkg_sandbox_local["sandbox-local"]
  pkg_sandbox_policy["sandbox-policy"]
  svc_sandboxPolicy["ctx.sandboxPolicy<br/>Sandbox policy home"]
  pkg_fs_sandbox["fs-sandbox"]
  pkg_user_approval["user-approval"]
  svc_approval["ctx.approval<br/>Approval seam"]
  pkg_permission_presets["permission-presets"]
  svc_permissionPresets["ctx.permissionPresets<br/>Permission presets"]
  pkg_ptc_runtime["ptc-runtime"]
  svc_ptcRuntime["ctx.ptcRuntime<br/>PTC execution seam"]
  pkg_ptc_runtime_node["ptc-runtime-node"]
  pkg_experimental_ptc_runtime_python["experimental-ptc-runtime-python"]
  pkg_workflow_ptc["workflow-ptc"]
  pkg_fs["fs"]
  svc_fs["ctx.fs<br/>Filesystem provider seam"]
  pkg_fs_local["fs-local"]
  pkg_fs_observation_policy["fs-observation-policy"]
  pkg_compaction["compaction"]
  svc_compaction["ctx.compaction<br/>Compaction seam"]
  svc_subagents["ctx.subagents<br/>Subagent provider and continuation service"]
  pkg_subagent_spawn_in_process["subagent-spawn-in-process"]
  pkg_subagent_fork_in_process["subagent-fork-in-process"]
  pkg_subagent_dsh_sdk["subagent-dsh-sdk"]
  pkg_tool_subagent_control["tool-subagent-control"]
  pkg_tool_ralph["tool-ralph"]
  pkg_experimental_speech_to_text["experimental-speech-to-text"]
  svc_speechToText["ctx.speechToText<br/>Experimental speech recognition providers"]
  pkg_experimental_speech_to_text_sensevoice["experimental-speech-to-text-sensevoice"]
  pkg_experimental_agent_team["experimental-agent-team"]
  svc_agentTeams["ctx.agentTeams<br/>Agent Teams coordination domain"]
  pkg_experimental_tool_agent_team["experimental-tool-agent-team"]
  pkg_experimental_client_ui_agent_team["experimental-client-ui-agent-team"]
  pkg_inspector["inspector"]
  svc_inspector["ctx.inspector<br/>Cross-realm runtime inspection"]
  pkg_jobs["jobs"]
  svc_jobs["ctx.jobs<br/>Background job registry"]
  pkg_jobs_local["jobs-local"]
  pkg_tool_jobs["tool-jobs"]
  pkg_web["web"]
  svc_web["ctx.web<br/>Web access provider registry"]
  pkg_web_search_exa["web-search-exa"]
  pkg_web_search_perplexity["web-search-perplexity"]
  pkg_web_search_deepseek["web-search-deepseek"]
  pkg_web_fetch_http["web-fetch-http"]
  pkg_spill["spill"]
  svc_spillStore["ctx.spillStore<br/>Spill storage seam"]
  pkg_spill_local["spill-local"]
  pkg_spill_policy["spill-policy"]
  pkg_host_directory_picker["host-directory-picker"]
  svc_directoryPicker["ctx.directoryPicker<br/>Workspace-directory picking seam"]
  pkg_host_directory_picker_native["host-directory-picker-native"]
  pkg_host_directory_picker_browse["host-directory-picker-browse"]
  pkg_host_webserver["host-webserver"]
  svc_webServer["ctx.webServer<br/>HTTP route registration"]
  pkg_client_modules["client-modules"]
  pkg_client_hmr["client-hmr"]
  svc_clientModules["ctx.clientModules<br/>Client plugin graph host"]
  pkg_workflow["workflow"]
  svc_workflowEngine["ctx.workflowEngine<br/>Workflow script engine"]
  pkg_tool_workflow["tool-workflow"]
  pkg_webhook["webhook"]
  svc_webhookRuntime["ctx.webhookRuntime<br/>Webhook rule runtime"]
  pkg_webhook_github["webhook-github"]
  pkg_lsp["lsp"]
  svc_lsp["ctx.lsp<br/>Language-server navigation seam"]
  pkg_tool_lsp["tool-lsp"]
  pkg_cordis_host_runner["cordis-host-runner"]
  svc_dynamicCordisRunner["ctx.dynamicCordisRunner<br/>Dynamic Cordis package host runner"]
  svc_cordisInspect["ctx.cordisInspect<br/>Dynamic Cordis inspect registry"]
  pkg_agent --> svc_agents
  pkg_agent_context --> svc_agentContext
  pkg_agent_default_model --> svc_agentDefaultModel
  pkg_agent_kernel --> svc_agentKernel
  pkg_agent_loop --> svc_agentLoop
  pkg_agent_preset_registry --> svc_agentPresets
  pkg_api_gateway --> svc_typertGateway
  pkg_api_job_controller --> svc_jobController
  pkg_api_session_controller --> svc_sessionController
  pkg_api_session_controller --> svc_sessionFileReferences
  pkg_api_session_controller --> svc_sessionSkillCatalog
  pkg_api_settings_controller --> svc_credentialsController
  pkg_api_settings_controller --> svc_settingsController
  pkg_api_terminal_controller --> svc_terminalController
  pkg_api_workspace_controller --> svc_directoryPickerController
  pkg_api_workspace_controller --> svc_workspaceController
  pkg_api_workspace_files --> svc_workspaceFiles
  pkg_app_boot --> svc_profileContext
  pkg_attachment --> svc_attachments
  pkg_attachment_local --> svc_attachments
  pkg_authorization --> svc_authorization
  pkg_authorization_remote --> svc_authorizationRemote
  pkg_bash_local --> svc_shell
  pkg_bash_sandbox --> svc_shell
  pkg_browser_use --> svc_browserUse
  pkg_client_connection --> svc_connection
  pkg_client_file_upload --> svc_fileUploads
  pkg_client_modules --> svc_clientModules
  pkg_client_ui_evolution --> svc_evolutionCuratorStatus
  pkg_client_ui_plugin_manager --> svc_pluginRegistryProbe
  pkg_client_ui_usage_dashboard --> svc_usageDashboard
  pkg_client_ui_workspace_memory --> svc_workspaceMemoryController
  pkg_command_feedback --> svc_sessionFeedback
  pkg_commands --> svc_commands
  pkg_compaction --> svc_compaction
  pkg_compaction_basic --> svc_compaction
  pkg_compaction_tool_result_pruner --> svc_toolResultPruner
  pkg_computer_use --> svc_computerUse
  pkg_config_editor --> svc_configEditor
  pkg_cordis_host_runner --> svc_cordisInspect
  pkg_cordis_host_runner --> svc_dynamicCordisRunner
  pkg_credentials --> svc_credentials
  pkg_credentials_local --> svc_credentials
  pkg_deepseek_account --> svc_deepseekAccount
  pkg_deepseek_account_platform --> svc_deepseekAccount
  pkg_deepseek_llm_api_extensions --> svc_deepseekLlmApiExtensions
  pkg_embeddings --> svc_embeddings
  pkg_embeddings_http --> svc_embeddings
  pkg_evolution_adversary --> svc_evolutionAdversary
  pkg_evolution_benchmark --> svc_evolutionBenchmark
  pkg_evolution_budget --> svc_evolutionBudget
  pkg_evolution_canary --> svc_evolutionCanary
  pkg_evolution_controller --> svc_evolutionController
  pkg_evolution_curator --> svc_evolutionCurator
  pkg_evolution_curriculum --> svc_evolutionCurriculum
  pkg_evolution_dreaming --> svc_evolutionDreaming
  pkg_evolution_evaluator_health --> svc_evolutionEvaluatorHealth
  pkg_evolution_evaluator_strategy --> svc_evolutionEvaluatorStrategy
  pkg_evolution_feedback --> svc_evolutionFeedback
  pkg_evolution_graph --> svc_evolutionGraph
  pkg_evolution_heartbeat --> svc_evolutionHeartbeat
  pkg_evolution_islands --> svc_evolutionIslands
  pkg_evolution_lineage --> svc_evolutionLineage
  pkg_evolution_memory --> svc_evolutionMemory
  pkg_evolution_meta --> svc_evolutionMeta
  pkg_evolution_metrics --> svc_evolutionMetrics
  pkg_evolution_model_routes --> svc_evolutionModelRoutes
  pkg_evolution_novelty_search --> svc_evolutionNovelty
  pkg_evolution_operators --> svc_evolutionOperators
  pkg_evolution_population --> svc_evolutionPopulation
  pkg_evolution_retrieval --> svc_evolutionRetrieval
  pkg_evolution_reviewer --> svc_evolutionReviewer
  pkg_evolution_router --> svc_evolutionRouter
  pkg_evolution_scorer --> svc_evolutionScorer
  pkg_evolution_self_model --> svc_evolutionSelfModel
  pkg_evolution_skill_telemetry --> svc_evolutionSkillTelemetry
  pkg_evolution_sleeptime --> svc_evolutionSleeptime
  pkg_evolution_stagnation --> svc_evolutionStagnation
  pkg_evolution_trace --> svc_evolutionTrace
  pkg_evolution_trajectory --> svc_evolutionTrajectory
  pkg_evolution_uncertainty --> svc_evolutionUncertainty
  pkg_evolution_verifiers --> svc_evolutionVerifiers
  pkg_experimental_agent_team --> svc_agentTeams
  pkg_experimental_api_speech_to_text --> svc_speechController
  pkg_experimental_browser_use_chrome_devtools_mcp --> svc_browserUse
  pkg_experimental_browser_use_playwright_mcp --> svc_browserUse
  pkg_experimental_browser_use_stagehand_native --> svc_browserUse
  pkg_experimental_computer_use_cua_driver_mcp --> svc_computerUse
  pkg_experimental_computer_use_cua_driver_native --> svc_computerUse
  pkg_experimental_ptc_runtime_python --> svc_ptcRuntime
  pkg_experimental_speech_to_text --> svc_speechToText
  pkg_experimental_speech_to_text_sensevoice --> svc_speechToText
  pkg_file_reference --> svc_fileReferences
  pkg_file_reference_local --> svc_fileReferences
  pkg_fs --> svc_fs
  pkg_fs_local --> svc_fs
  pkg_fs_sandbox --> svc_fs
  pkg_fs_ssh --> svc_fs
  pkg_goal --> svc_goals
  pkg_hmr --> svc_hmr
  pkg_host_directory_picker --> svc_directoryPicker
  pkg_host_directory_picker_browse --> svc_directoryPicker
  pkg_host_directory_picker_native --> svc_directoryPicker
  pkg_host_product_telemetry_otel --> svc_productTelemetry
  pkg_host_webserver --> svc_webServer
  pkg_inspector --> svc_inspector
  pkg_invariants --> svc_invariants
  pkg_jobs --> svc_jobs
  pkg_jobs_local --> svc_jobs
  pkg_llm --> svc_llm
  pkg_llm_deepseek --> svc_llm
  pkg_llm_pi_ai --> svc_llm
  pkg_llm_replay --> svc_llm
  pkg_lsp --> svc_lsp
  pkg_lsp_stdio --> svc_lsp
  pkg_mcp_client --> svc_mcpResources
  pkg_mcp_resources --> svc_mcpResources
  pkg_message_feedback --> svc_messageFeedback
  pkg_office_to_pdf --> svc_officeToPdf
  pkg_permission_presets --> svc_permissionPresets
  pkg_plan_mode --> svc_planMode
  pkg_plugin_manager --> svc_pluginManager
  pkg_plugin_package_inventory_deepseek --> svc_deepseekLlmApiExtensions
  pkg_ptc_runtime --> svc_ptcRuntime
  pkg_ptc_runtime_node --> svc_ptcRuntime
  pkg_pwsh_local --> svc_shell
  pkg_sandbox --> svc_sandbox
  pkg_sandbox_local --> svc_sandbox
  pkg_sandbox_policy --> svc_sandboxPolicy
  pkg_sandbox_ssh --> svc_sandbox
  pkg_session --> svc_sessions
  pkg_session_log_deepseek --> svc_deepseekLlmApiExtensions
  pkg_session_persistence --> svc_sessionPersistence
  pkg_session_persistence_jsonl --> svc_sessionPersistence
  pkg_session_projection --> svc_sessionProjections
  pkg_session_projection_cache --> svc_sessionProjectionCache
  pkg_session_query --> svc_sessionQuery
  pkg_session_query_sqlite --> svc_sessionQuery
  pkg_session_reference --> svc_sessionReferenceResolver
  pkg_session_telemetry --> svc_sessionTelemetry
  pkg_session_telemetry_otel --> svc_sessionTelemetry
  pkg_session_title --> svc_sessionTitle
  pkg_session_title_all_prompts_llm --> svc_sessionTitle
  pkg_session_title_first_prompt_llm --> svc_sessionTitle
  pkg_settings --> svc_settings
  pkg_shell --> svc_shell
  pkg_shell_env --> svc_shellEnv
  pkg_skill --> svc_skills
  pkg_skill_badge --> svc_skills
  pkg_skill_filesystem --> svc_skills
  pkg_skill_office --> svc_skills
  pkg_spill --> svc_spillStore
  pkg_spill_local --> svc_spillStore
  pkg_ssh --> svc_ssh
  pkg_storage --> svc_storage
  pkg_storage_domain --> svc_storageDomain
  pkg_storage_json --> svc_storage
  pkg_storage_sqlite --> svc_storage
  pkg_subagent --> svc_subagents
  pkg_subagent_acp --> svc_subagents
  pkg_subagent_claude_code --> svc_subagents
  pkg_subagent_codex --> svc_subagents
  pkg_subagent_dsh_sdk --> svc_subagents
  pkg_subagent_fork_in_process --> svc_subagents
  pkg_subagent_spawn_in_process --> svc_subagents
  pkg_subprocess --> svc_subprocess
  pkg_subprocess_local --> svc_subprocess
  pkg_subprocess_ssh --> svc_subprocess
  pkg_system_prompt --> svc_systemPrompt
  pkg_terminal --> svc_terminals
  pkg_terminal_bash --> svc_terminals
  pkg_token_meter --> svc_tokenMeter
  pkg_tool_subagent --> svc_subagentModelSelection
  pkg_tools --> svc_tools
  pkg_typert_registry --> svc_typert
  pkg_usage_ledger --> svc_usageLedger
  pkg_user_approval --> svc_approval
  pkg_user_questions --> svc_userQuestions
  pkg_web --> svc_web
  pkg_web_fetch_http --> svc_web
  pkg_web_search_deepseek --> svc_web
  pkg_web_search_exa --> svc_web
  pkg_web_search_perplexity --> svc_web
  pkg_webhook --> svc_webhookRuntime
  pkg_workflow --> svc_workflowEngine
  pkg_workflow_ptc --> svc_workflowEngine
  pkg_workspace --> svc_workspaceRegistry
  pkg_workspace_changes --> svc_workspaceChanges
  pkg_workspace_memory --> svc_workspaceMemory
  pkg_workspace_memory_llm --> svc_workspaceMemoryExtractor
  svc_agentDefaultModel --> pkg_api_session_controller
  svc_agentDefaultModel --> pkg_headless
  svc_agentLoop --> pkg_base
  svc_agentLoop --> pkg_sdk_minimal
  svc_agentTeams --> pkg_experimental_client_ui_agent_team
  svc_agentTeams --> pkg_experimental_tool_agent_team
  svc_agents --> pkg_acp
  svc_agents --> pkg_agent_loop
  svc_agents --> pkg_subagent_in_process_driver
  svc_approval --> pkg_acp
  svc_approval --> pkg_tool_bash
  svc_approval --> pkg_tools
  svc_attachments --> pkg_api_session_controller
  svc_attachments --> pkg_llm_deepseek
  svc_attachments --> pkg_llm_pi_ai
  svc_attachments --> pkg_tool_fs
  svc_authorization --> pkg_llm_pi_ai
  svc_browserUse --> pkg_experimental_browser_use_chrome_devtools_mcp
  svc_browserUse --> pkg_experimental_browser_use_playwright_mcp
  svc_browserUse --> pkg_experimental_browser_use_stagehand_native
  svc_clientModules --> pkg_client_hmr
  svc_compaction --> pkg_compaction_basic
  svc_computerUse --> pkg_experimental_computer_use_cua_driver_mcp
  svc_computerUse --> pkg_experimental_computer_use_cua_driver_native
  svc_configEditor --> pkg_agent_default_model
  svc_configEditor --> pkg_settings
  svc_connection --> pkg_api_gateway
  svc_connection --> pkg_host_frontend_static
  svc_cordisInspect --> pkg_tool_cordis
  svc_credentials --> pkg_api_settings_controller
  svc_credentials --> pkg_llm_deepseek
  svc_credentials --> pkg_llm_pi_ai
  svc_deepseekAccount --> pkg_api_account_controller
  svc_deepseekAccount --> pkg_llm_deepseek
  svc_deepseekLlmApiExtensions --> pkg_llm_deepseek
  svc_directoryPicker --> pkg_api_workspace_controller
  svc_dynamicCordisRunner --> pkg_tool_cordis
  svc_evolutionAdversary --> pkg_command_evolution
  svc_evolutionBenchmark --> pkg_command_evolution
  svc_evolutionBudget --> pkg_command_evolution
  svc_evolutionBudget --> pkg_evolution_optimizer
  svc_evolutionCanary --> pkg_command_evolution
  svc_evolutionCanary --> pkg_evolution_optimizer
  svc_evolutionCurriculum --> pkg_command_evolution
  svc_evolutionCurriculum --> pkg_evolution_benchmark
  svc_evolutionEvaluatorHealth --> pkg_command_evolution
  svc_evolutionEvaluatorHealth --> pkg_evolution_scorer
  svc_evolutionEvaluatorStrategy --> pkg_command_evolution
  svc_evolutionEvaluatorStrategy --> pkg_evolution_optimizer
  svc_evolutionFeedback --> pkg_evolution_curator
  svc_evolutionFeedback --> pkg_evolution_dreaming
  svc_evolutionIslands --> pkg_command_evolution
  svc_evolutionIslands --> pkg_evolution_optimizer
  svc_evolutionLineage --> pkg_command_evolution
  svc_evolutionLineage --> pkg_evolution_optimizer
  svc_evolutionMemory --> pkg_command_evolution
  svc_evolutionMemory --> pkg_evolution_memory_context
  svc_evolutionMemory --> pkg_evolution_reviewer
  svc_evolutionMeta --> pkg_command_evolution
  svc_evolutionMeta --> pkg_evolution_optimizer
  svc_evolutionMetrics --> pkg_command_evolution
  svc_evolutionModelRoutes --> pkg_command_evolution
  svc_evolutionModelRoutes --> pkg_evolution_optimizer
  svc_evolutionNovelty --> pkg_command_evolution
  svc_evolutionNovelty --> pkg_evolution_optimizer
  svc_evolutionOperators --> pkg_command_evolution
  svc_evolutionOperators --> pkg_evolution_optimizer
  svc_evolutionPopulation --> pkg_command_evolution
  svc_evolutionPopulation --> pkg_evolution_optimizer
  svc_evolutionRetrieval --> pkg_command_evolution
  svc_evolutionReviewer --> pkg_command_evolution
  svc_evolutionRouter --> pkg_command_evolution
  svc_evolutionRouter --> pkg_evolution_optimizer
  svc_evolutionScorer --> pkg_evolution_optimizer
  svc_evolutionSelfModel --> pkg_command_evolution
  svc_evolutionSelfModel --> pkg_evolution_optimizer
  svc_evolutionSkillTelemetry --> pkg_evolution_curator
  svc_evolutionSkillTelemetry --> pkg_evolution_skill_manage
  svc_evolutionSleeptime --> pkg_command_evolution
  svc_evolutionStagnation --> pkg_command_evolution
  svc_evolutionStagnation --> pkg_evolution_optimizer
  svc_evolutionTrace --> pkg_command_evolution
  svc_evolutionUncertainty --> pkg_command_evolution
  svc_evolutionUncertainty --> pkg_evolution_scorer
  svc_evolutionVerifiers --> pkg_evolution_curator
  svc_fileReferences --> pkg_api_session_controller
  svc_fileUploads --> pkg_api_session_controller
  svc_fs --> pkg_tool_fs
  svc_hmr --> pkg_app_boot
  svc_invariants --> pkg_agent
  svc_invariants --> pkg_agent_loop
  svc_invariants --> pkg_scope
  svc_invariants --> pkg_session
  svc_jobs --> pkg_api_job_controller
  svc_jobs --> pkg_tool_bash
  svc_jobs --> pkg_tool_jobs
  svc_jobs --> pkg_tool_pwsh
  svc_jobs --> pkg_tool_subagent
  svc_jobs --> pkg_tool_terminal
  svc_llm --> pkg_agent_loop
  svc_llm --> pkg_compaction_basic
  svc_lsp --> pkg_tool_lsp
  svc_mcpResources --> pkg_mcp_resources
  svc_officeToPdf --> pkg_client_ui_sidebar_documentpreview
  svc_pluginManager --> pkg_plugin_manager
  svc_pluginManager --> pkg_ui_settings_plugin_inventory
  svc_pluginRegistryProbe --> pkg_client_ui_plugin_manager
  svc_profileContext --> pkg_plugin_manager
  svc_ptcRuntime --> pkg_tools
  svc_ptcRuntime --> pkg_workflow_ptc
  svc_sandbox --> pkg_bash_sandbox
  svc_sandbox --> pkg_terminal_bash
  svc_sandboxPolicy --> pkg_bash_sandbox
  svc_sandboxPolicy --> pkg_fs_sandbox
  svc_sandboxPolicy --> pkg_terminal_bash
  svc_sessionPersistence --> pkg_agent_loop
  svc_sessionPersistence --> pkg_hooks_claude_code
  svc_sessionPersistence --> pkg_hooks_codex
  svc_sessionPersistence --> pkg_message_feedback
  svc_sessionPersistence --> pkg_session_query
  svc_sessionPersistence --> pkg_session_query_sqlite
  svc_sessionPersistence --> pkg_tool_bash
  svc_sessionProjectionCache --> pkg_api_session_controller
  svc_sessionProjectionCache --> pkg_session_query
  svc_sessionProjectionCache --> pkg_session_reference
  svc_sessionProjectionCache --> pkg_subagent
  svc_sessionProjections --> pkg_api_session_controller
  svc_sessionProjections --> pkg_session_title
  svc_sessionProjections --> pkg_tool_todo
  svc_sessionQuery --> pkg_active_memory_context
  svc_sessionQuery --> pkg_session_reference
  svc_sessionQuery --> pkg_tool_session_query
  svc_sessions --> pkg_agent
  svc_sessions --> pkg_agent_loop
  svc_sessions --> pkg_invariants
  svc_sessions --> pkg_message_feedback
  svc_sessions --> pkg_session_persistence
  svc_sessions --> pkg_session_query
  svc_sessions --> pkg_session_query_sqlite
  svc_sessions --> pkg_subagent_in_process_driver
  svc_settings --> pkg_api_settings_controller
  svc_shell --> pkg_hooks_claude_code
  svc_shell --> pkg_hooks_codex
  svc_shell --> pkg_tool_bash
  svc_shell --> pkg_tool_pwsh
  svc_shellEnv --> pkg_tool_bash
  svc_shellEnv --> pkg_tool_pwsh
  svc_skills --> pkg_tool_skill
  svc_speechToText --> pkg_experimental_api_speech_to_text
  svc_spillStore --> pkg_spill_policy
  svc_ssh --> pkg_fs_ssh
  svc_ssh --> pkg_sandbox_ssh
  svc_ssh --> pkg_subprocess_ssh
  svc_storage --> pkg_storage_domain
  svc_storageDomain --> pkg_workspace
  svc_subagentModelSelection --> pkg_tool_subagent
  svc_subagents --> pkg_tool_ralph
  svc_subagents --> pkg_tool_subagent
  svc_subagents --> pkg_tool_subagent_control
  svc_subprocess --> pkg_bash_local
  svc_subprocess --> pkg_bash_sandbox
  svc_subprocess --> pkg_lsp_stdio
  svc_subprocess --> pkg_subagent_acp
  svc_subprocess --> pkg_subagent_claude_code
  svc_subprocess --> pkg_subagent_codex
  svc_subprocess --> pkg_terminal_bash
  svc_systemPrompt --> pkg_agent_loop
  svc_systemPrompt --> pkg_tool_fs
  svc_systemPrompt --> pkg_tool_terminal
  svc_systemPrompt --> pkg_tool_web
  svc_systemPrompt --> pkg_tools
  svc_terminals --> pkg_tool_terminal
  svc_tokenMeter --> pkg_compaction_basic
  svc_toolResultPruner --> pkg_compaction_basic
  svc_tools --> pkg_agent_loop
  svc_tools --> pkg_tool_ask_user
  svc_tools --> pkg_tool_bash
  svc_tools --> pkg_tool_cordis
  svc_tools --> pkg_tool_fs
  svc_tools --> pkg_tool_skill
  svc_tools --> pkg_tool_subagent
  svc_tools --> pkg_tool_terminal
  svc_tools --> pkg_tool_todo
  svc_tools --> pkg_tool_web
  svc_typert --> pkg_api_gateway
  svc_typert --> pkg_typert_loader
  svc_usageLedger --> pkg_client_ui_usage_dashboard
  svc_userQuestions --> pkg_tool_ask_user
  svc_web --> pkg_tool_web
  svc_webServer --> pkg_client_connection
  svc_webServer --> pkg_client_hmr
  svc_webServer --> pkg_client_modules
  svc_webhookRuntime --> pkg_webhook_github
  svc_workflowEngine --> pkg_tool_ralph
  svc_workflowEngine --> pkg_tool_workflow
  svc_workspaceMemory --> pkg_client_ui_workspace_memory
  svc_workspaceMemory --> pkg_workspace_memory_context
  svc_workspaceMemory --> pkg_workspace_memory_llm
  svc_workspaceMemoryExtractor --> pkg_client_ui_workspace_memory
  svc_workspaceRegistry --> pkg_active_memory_context
  svc_workspaceRegistry --> pkg_api_session_controller
  svc_workspaceRegistry --> pkg_api_workspace_controller
  svc_fs -. event gate .-> pkg_fs_observation_policy
```

| ctx 键 | 角色 | 所属包 | 实现 | 直接消费方 | 配套插件 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| `ctx.agentKernel` | `core` | [`agent-kernel`](../packages/runtime/agent-kernel) | - | - | - | 观察 agent loop 与工具 waterfall 而不拥有执行；会话日志是它唯一的存储，它组合自己并不作出的沙箱与审批决策。 |
| `ctx.agentContext` | `core` | [`agent-context`](../packages/runtime/agent-context) | - | - | - | 观察组装过程与 kernel 视图，但不拥有二者；它记录一次模型步骤所依据的放置，并在 apply 模式下移除被上限裁掉的可压缩来源。 |
| `ctx.hmr` | `core` | [`hmr`](../packages/boot/hmr) | - | [`app-boot`](../packages/boot/app-boot) | - | 负责模块和精确配置监听；应用修改共用其队列，自动重载等待应用文件锁。 |
| `ctx.pluginRegistryProbe` | `core` | [`client-ui-plugin-manager`](../packages/client/ui-plugin-manager) | - | [`client-ui-plugin-manager`](../packages/client/ui-plugin-manager) | - | 在 Host 上并发比较公共安装源响应；初始安装源推荐由 Client 负责。 |
| `ctx.pluginManager` | `core` | [`plugin-manager`](../packages/boot/plugin-manager) | - | [`plugin-manager`](../packages/boot/plugin-manager), `ui-settings-plugin-inventory` | - | 与 CLI 共享 profile 包操作，并向 Web 和 Agent 调用方分别报告持久状态与运行状态。 |
| `ctx.profileContext` | `core` | [`app-boot`](../packages/boot/app-boot) | - | [`plugin-manager`](../packages/boot/plugin-manager) | - | dsh launcher 提供纯数据形式的 profile 位置与组合输入；重载调度由 dsh-hmr 负责。 |
| `ctx.connection` | `core` | [`client-connection`](../packages/client/connection) | - | [`api-gateway`](../packages/api/gateway), [`host-frontend-static`](../packages/host/frontend-static) | - | 负责浏览器认证与共享 HTTP 请求分发；API 适配器注册端点和流。 |
| `ctx.mcpResources` | `seam` | [`mcp-resources`](../packages/mcp/mcp-resources) | [`mcp-client`](../packages/mcp/mcp-client) | [`mcp-resources`](../packages/mcp/mcp-resources) | - | 连接所有者提供的操作在调用 agent 的作用域内服务于共享资源工具。 |
| `ctx.browserUse` | `seam` | [`browser-use`](../packages/browser-use/browser-use) | [`experimental-browser-use-playwright-mcp`](../packages/experimental/browser-use-playwright-mcp), [`experimental-browser-use-chrome-devtools-mcp`](../packages/experimental/browser-use-chrome-devtools-mcp), [`experimental-browser-use-stagehand-native`](../packages/experimental/browser-use-stagehand-native) | [`experimental-browser-use-playwright-mcp`](../packages/experimental/browser-use-playwright-mcp), [`experimental-browser-use-chrome-devtools-mcp`](../packages/experimental/browser-use-chrome-devtools-mcp), [`experimental-browser-use-stagehand-native`](../packages/experimental/browser-use-stagehand-native) | - | 每个服务实例注册一个提供方拥有的名称。提供方按实时 Session 拥有自己的工具与浏览器资源；共享服务不提供浏览器操作 API。 |
| `ctx.computerUse` | `seam` | [`computer-use`](../packages/computer-use/computer-use) | [`experimental-computer-use-cua-driver-mcp`](../packages/experimental/computer-use-cua-driver-mcp), [`experimental-computer-use-cua-driver-native`](../packages/experimental/computer-use-cua-driver-native) | [`experimental-computer-use-cua-driver-mcp`](../packages/experimental/computer-use-cua-driver-mcp), [`experimental-computer-use-cua-driver-native`](../packages/experimental/computer-use-cua-driver-native) | - | 每个服务实例只注册一个提供方自定的名称。各提供方也拥有自己的模型工具；服务不提供通用操作 API、运行时选择或 Session 流程锁。 |
| `ctx.officeToPdf` | `core` | [`office-to-pdf`](../packages/document/office-to-pdf) | - | [`client-ui-sidebar-documentpreview`](../packages/client/ui-sidebar-documentpreview) | - | 已授权的 Office 字节在宿主上使用已声明的原生目标引擎转换；未声明原生目标时使用 Node WASM。 |
| `ctx.attachments` | `seam` | [`attachment`](../packages/attachment/attachment) | [`attachment-local`](../packages/attachment/attachment-local) | [`api-session-controller`](../packages/api/session-controller), [`tool-fs`](../packages/fs/tool-fs), [`llm-pi-ai`](../packages/llm/llm-pi-ai), [`llm-deepseek`](../packages/llm/llm-deepseek) | - | 宿主会在会话事件之前提交已接受的图片；提供方适配器将已授权的持久引用解析为提供方原生内容。 |
| `ctx.fileUploads` | `core` | [`client-file-upload`](../packages/client/file-upload) | - | [`api-session-controller`](../packages/api/session-controller) | - | 负责流式接收、持久存储和暂存回执生命周期；Session Controller 将回执绑定到已接受的提交。 |
| `ctx.embeddings` | `seam` | [`embeddings`](../packages/llm/embeddings) | [`embeddings-http`](../packages/llm/embeddings-http) | - | - | 提供方注册嵌入路由；一批调用解析其路由与模型，先返回内容哈希缓存中已有的结果，其余向提供方请求。目前尚无仓库内消费方注入该服务。 |
| `ctx.llm` | `seam` | [`llm`](../packages/llm/llm) | [`llm-deepseek`](../packages/llm/llm-deepseek), [`llm-pi-ai`](../packages/llm/llm-pi-ai), [`llm-replay`](../packages/test-support/llm-replay) | [`agent-loop`](../packages/core/agent-loop), [`compaction-basic`](../packages/compaction/compaction-basic) | - | 适配器注册提供方实现；agent loop（智能体循环）与压缩功能调用提供方无关的流服务。 |
| `ctx.deepseekLlmApiExtensions` | `seam` | [`deepseek-llm-api-extensions`](../packages/llm/deepseek-llm-api-extensions) | [`session-log-deepseek`](../packages/session/session-log-deepseek), [`plugin-package-inventory-deepseek`](../packages/llm/plugin-package-inventory-deepseek) | [`llm-deepseek`](../packages/llm/llm-deepseek) | - | 插件准备彼此独立的顶层字段；官方适配器会合并这些字段，并在 HTTP 接受后提交其交付状态。 |
| `ctx.tokenMeter` | `core` | [`token-meter`](../packages/llm/token-meter) | - | [`compaction-basic`](../packages/compaction/compaction-basic) | - | 拥有按会话隔离的回放折叠区；压力消费方共享不可变且带修订版本的测量结果。 |
| `ctx.toolResultPruner` | `core` | [`compaction-tool-result-pruner`](../packages/compaction/compaction-tool-result-pruner) | - | [`compaction-basic`](../packages/compaction/compaction-basic) | - | 在摘要压缩前，通过可回放的单节点表层替换来改写过大的当前工具结果。 |
| `ctx.sessions` | `core` | [`session`](../packages/core/session) | - | [`agent-loop`](../packages/core/agent-loop), [`agent`](../packages/core/agent), [`session-persistence`](../packages/session/session-persistence), [`session-query`](../packages/session-query/session-query), [`session-query-sqlite`](../packages/session-query/session-query-sqlite), [`subagent-in-process-driver`](../packages/subagent/subagent-in-process-driver), [`invariants`](../packages/runtime-diagnostics/invariants), [`message-feedback`](../packages/feedback/message-feedback) | - | 拥有仅追加的 Session 实例，并发出持久的会话事件流。 |
| `ctx.speechController` | `core` | [`experimental-api-speech-to-text`](../packages/experimental/api-speech-to-text) | - | - | - | 在 Provider 调用前校验受限的浏览器音频。 |
| `ctx.sessionController` | `core` | [`api-session-controller`](../packages/api/session-controller) | - | - | - | 负责 Session 命令、冷读取、持久事件跟随、实时控制状态、模型目录、workspace 打开与 Agent 激活策略。 |
| `ctx.sessionFileReferences` | `core` | [`api-session-controller`](../packages/api/session-controller) | - | - | - | 通过 Session Controller 的既有 Agent lookup 策略委托文件引用发现。 |
| `ctx.sessionSkillCatalog` | `core` | [`api-session-controller`](../packages/api/session-controller) | - | - | - | 在不激活冷 Agent 的前提下列出 Session 组合中允许用户调用的 skill。 |
| `ctx.jobController` | `core` | [`api-job-controller`](../packages/api/job-controller) | - | - | - | 经生成的 Remote namespace 流式发送一个后台任务的观测 record；名册仍在会话控制流上。 |
| `ctx.credentialsController` | `core` | [`api-settings-controller`](../packages/api/settings-controller) | - | - | - | 把凭据引用 seam 投影到生成的 Remote namespace：批量扇出、视图投影与拒绝映射都在这里，而不在 seam Definition 上。 |
| `ctx.authorizationRemote` | `core` | [`authorization-remote`](../packages/credentials/authorization-remote) | - | - | - | 把授权 flow 注册表投影到生成的 Remote namespace：尝试、按游标轮询的对话帧与提示词回答都在这里，而 flow 生命周期与提交确认由 seam 负责。 |
| `ctx.settingsController` | `core` | [`api-settings-controller`](../packages/api/settings-controller) | - | - | - | 把用户设置 seam 投影到生成的 Remote namespace：读取一律脱敏，所有拒绝在这里分类，而不在 seam Definition 上。 |
| `ctx.workspaceFiles` | `core` | [`api-workspace-files`](../packages/api/workspace-files) | - | - | - | 为会话工作区根内的文件提供 stat、分页文本、字节窗口、目录列举与变更流，经 lstat、包含关系与 stat 重检限定。 |
| `ctx.workspaceChanges` | `core` | [`workspace-changes`](../packages/deliverables/workspace-changes) | - | - | - | Serves the summary each workspace/changes event announced and each listed file's turn-start and turn-end comparison, by Session and event sequence, until that Session is disposed; the log carries only the turn. |
| `ctx.terminalController` | `core` | [`api-terminal-controller`](../packages/api/terminal-controller) | - | - | - | 通过子进程提供方与类型化 Remote 传输管理用户终端进程、解析默认 shell，并恢复有界终端屏幕。 |
| `ctx.workspaceController` | `core` | [`api-workspace-controller`](../packages/api/workspace-controller) | - | - | - | 通过生成的 Remote namespace 负责 Workspace 命令和可在重连后收敛的 Workspace 状态投递。 |
| `ctx.directoryPickerController` | `core` | [`api-workspace-controller`](../packages/api/workspace-controller) | - | - | - | 把选目录 seam 送上线：能力门禁、取消传播，以及浏览器目录流程用于分支判断的 seam 错误码。 |
| `ctx.invariants` | `core` | [`invariants`](../packages/runtime-diagnostics/invariants) | - | [`session`](../packages/core/session), [`agent`](../packages/core/agent), [`scope`](../packages/core/scope), [`agent-loop`](../packages/core/agent-loop) | - | 配套子路径注册所属包本地的检查；该服务负责选择、唯一性、子 fiber，以及标明所属包的失败。 |
| `ctx.typert` | `core` | [`typert-registry`](../packages/typert/registry) | - | [`typert-loader`](../packages/typert/loader), [`api-gateway`](../packages/api/gateway) | - | 插件直接或通过 dsh-typert-loader 注册实时 zod 贡献；API 网关消费调用描述符和提供方，其他运行时消费方则在各自边界查询 schema 与反射元数据。 |
| `ctx.typertGateway` | `core` | [`api-gateway`](../packages/api/gateway) | - | - | - | 将生成的 Remote 描述符与实时 Cordis 服务关联，解析已注册的身份，并通过共享的 Connection RPC 载体提供一元调用。 |
| `ctx.sessionPersistence` | `seam` | [`session-persistence`](../packages/session/session-persistence) | [`session-persistence-jsonl`](../packages/session/session-persistence-jsonl) | [`agent-loop`](../packages/core/agent-loop), [`tool-bash`](../packages/shell/tool-bash), [`hooks-claude-code`](../packages/hooks/hooks-claude-code), [`hooks-codex`](../packages/hooks/hooks-codex), [`session-query`](../packages/session-query/session-query), [`session-query-sqlite`](../packages/session-query/session-query-sqlite), [`message-feedback`](../packages/feedback/message-feedback) | - | JSONL backend 把 SessionEvent 词汇持久化为每个 Session 一份产物。 |
| `ctx.configEditor` | `core` | [`config-editor`](../packages/boot/config-editor) | - | [`settings`](../packages/settings/settings), [`agent-default-model`](../packages/core/agent-default-model) | - | Persists profile config patches under the application file lock and HMR queue, then reconciles Loader entries. |
| `ctx.settings` | `core` | [`settings`](../packages/settings/settings) | - | [`api-settings-controller`](../packages/api/settings-controller) | - | Forms project volatile Config fields from active profile entries and delegate validated edits to config-editor. Plugins consume their own Config references. |
| `ctx.subagentModelSelection` | `core` | [`tool-subagent`](../packages/subagent/tool-subagent) | - | [`tool-subagent`](../packages/subagent/tool-subagent) | - | 拥有默认关闭的设置命名空间；Agent 作用域的委派工具会在组合新顶层 Session 时读取它。 |
| `ctx.credentials` | `seam` | [`credentials`](../packages/credentials/credentials) | [`credentials-local`](../packages/credentials/credentials-local) | [`api-settings-controller`](../packages/api/settings-controller), [`llm-deepseek`](../packages/llm/llm-deepseek), [`llm-pi-ai`](../packages/llm/llm-pi-ai) | - | 配置携带对机密信息的引用；提供方拥有实际值。消费方按操作解析，因此轮换后的凭据会在紧接着的下一次请求中生效；settings controller 提供不含实际值的视图和只写存储。 |
| `ctx.deepseekAccount` | `seam` | [`deepseek-account`](../packages/credentials/deepseek-account) | [`deepseek-account-platform`](../packages/credentials/deepseek-account-platform) | [`api-account-controller`](../packages/api/account-controller), [`llm-deepseek`](../packages/llm/llm-deepseek) | - | Host 负责浏览器授权和本地凭证；UI 使用方只接收不含 token 的状态。 |
| `ctx.authorization` | `seam` | [`authorization`](../packages/credentials/authorization) | - | [`llm-pi-ai`](../packages/llm/llm-pi-ai) | - | flow 由知道如何取得某份凭据的插件注册，并以其写入的记录为键；seam 拥有这段对话与"每个键同时只跑一次尝试"的生命周期，而非协议本身。 |
| `ctx.productTelemetry` | `service` | [`host-product-telemetry-otel`](../packages/host/product-telemetry-otel) | - | - | - | 通过 OTLP/HTTP 发送显式提交的分析事件；仅挂载插件不会采集信息。 |
| `ctx.sessionTelemetry` | `seam` | [`session-telemetry`](../packages/session/session-telemetry) | [`session-telemetry-otel`](../packages/session/session-telemetry-otel) | - | - | 该 seam 捕获会话记录、进行脱敏并交给一个后端；没有其他组件消费该服务，其输出会离开当前进程。 |
| `ctx.storage` | `seam` | [`storage`](../packages/storage/storage) | [`storage-json`](../packages/storage/storage-json), [`storage-sqlite`](../packages/storage/storage-sqlite) | [`storage-domain`](../packages/storage/storage-domain) | - | 各后端以不同名称并列注册；数据形态（领域优先）挂载到枢纽上，并将类型化操作转换为不透明的 KV 单元原语。 |
| `ctx.storageDomain` | `core` | [`storage-domain`](../packages/storage/storage-domain) | - | [`workspace`](../packages/workspace/workspace) | - | 等待所有已配置后端就绪，然后将领域形态发布为一个受生命周期约束的服务，用于类型化持久状态。 |
| `ctx.messageFeedback` | `core` | [`message-feedback`](../packages/feedback/message-feedback) | - | - | - | 拥有权威 Session 日志中的逐 assistant 消息反馈、目标校验、逐条目 compare-and-set 及 Host 一元 Remote 契约。反馈不进入模型历史；日志导出遵循消费方策略。 |
| `ctx.sessionFeedback` | `core` | [`command-feedback`](../packages/feedback/command-feedback) | - | - | - | 通过 Host 一元 Remote 契约在 live Session 上把一条带分类的 Session 级评价记录为仅写日志的 feedback/record 事件；/feedback 命令共用同一个生产方。 |
| `ctx.workspaceRegistry` | `core` | [`workspace`](../packages/workspace/workspace) | - | [`api-workspace-controller`](../packages/api/workspace-controller), [`api-session-controller`](../packages/api/session-controller), [`active-memory-context`](../packages/context/active-memory-context) | - | 通过领域设施拥有带 WorkspaceId 品牌类型的记录；稳定的 sessionIds 账户驱动 Host RPC 与 GUI 投影。 |
| `ctx.workspaceMemory` | `core` | [`workspace-memory`](../packages/workspace/workspace-memory) | - | [`workspace-memory-llm`](../packages/workspace/workspace-memory-llm), [`workspace-memory-context`](../packages/context/workspace-memory-context), [`client-ui-workspace-memory`](../packages/client/ui-workspace-memory) | - | workspace-memory 插件拥有按 Workspace 持久化的记录；workspace-memory-llm 写入提取出的文档与索引产出，workspace-memory-context 渲染注入的简报，workspace memory 宿主面则负责读取与改写它。 |
| `ctx.workspaceMemoryExtractor` | `core` | [`workspace-memory-llm`](../packages/workspace/workspace-memory-llm) | - | [`client-ui-workspace-memory`](../packages/client/ui-workspace-memory) | - | workspace-memory-llm 插件根据会话历史推导记忆文档；workspace memory 宿主面调用其重建，没有其他包读取该服务。 |
| `ctx.workspaceMemoryController` | `core` | [`client-ui-workspace-memory`](../packages/client/ui-workspace-memory) | - | - | - | workspace memory 宿主面在 ctx.workspaceMemory 与 ctx.workspaceMemoryExtractor 之上提供 workspaceMemory Remote namespace；生成的 contribution 将它送到浏览器半，由浏览器半在线读取。 |
| `ctx.sessionQuery` | `seam` | [`session-query`](../packages/session-query/session-query) | [`session-query-sqlite`](../packages/session-query/session-query-sqlite) | [`session-reference`](../packages/context/session-reference), [`tool-session-query`](../packages/session-query/tool-session-query), [`active-memory-context`](../packages/context/active-memory-context) | - | 该接口提供精确读取、过滤和追踪；具体后端还提供全文协调、排序、摘要片段和游标世代，而模型消费方负责工作区权限与不含游标的渲染。 |
| `ctx.fileReferences` | `seam` | [`file-reference`](../packages/context/file-reference) | [`file-reference-local`](../packages/context/file-reference-local) | [`api-session-controller`](../packages/api/session-controller) | - | 该接口返回 Agent cwd 内仅含路径的补全候选；提供方负责命名空间访问与排序，但不读取文件内容。 |
| `ctx.sessionReferenceResolver` | `core` | [`session-reference`](../packages/context/session-reference) | - | - | - | 将当前表层中有界的对话快照投影为持久但不可信的消息上下文；Host 适配器负责提及语法。 |
| `ctx.sessionTitle` | `seam` | [`session-title`](../packages/session/session-title) | [`session-title-first-prompt-llm`](../packages/session/session-title-first-prompt-llm), [`session-title-all-prompts-llm`](../packages/session/session-title-all-prompts-llm) | - | - | 负责确定性回退、最新标题折叠区，以及唯一的可选异步提供方注册。 |
| `ctx.systemPrompt` | `core` | [`system-prompt`](../packages/core/system-prompt) | - | [`agent-loop`](../packages/core/agent-loop), [`tools`](../packages/core/tools), [`tool-fs`](../packages/fs/tool-fs), [`tool-terminal`](../packages/terminal/tool-terminal), [`tool-web`](../packages/web/tool-web) | - | 为每个步骤收集提示词各部分和面向模型的工具 schema。 |
| `ctx.tools` | `core` | [`tools`](../packages/core/tools) | - | [`agent-loop`](../packages/core/agent-loop), [`tool-ask-user`](../packages/interaction/tool-ask-user), [`tool-bash`](../packages/shell/tool-bash), [`tool-cordis`](../packages/extensions/tool-cordis), [`tool-fs`](../packages/fs/tool-fs), [`tool-terminal`](../packages/terminal/tool-terminal), [`tool-skill`](../packages/skill/tool-skill), [`tool-subagent`](../packages/subagent/tool-subagent), [`tool-todo`](../packages/todo/tool-todo), [`tool-web`](../packages/web/tool-web) | - | 注册能力，负责 PTC mode 传输，并让调用依次经过策略前处理、单调守卫、环绕分派、策略后处理和最终结果观测。 |
| `ctx.userQuestions` | `seam` | [`user-questions`](../packages/interaction/user-questions) | - | [`tool-ask-user`](../packages/interaction/tool-ask-user) | - | UI 前端提供当前生效的人工回答提供方；tool-ask-user 在提供方无关的 ask() promise 上暂停工具调用。 |
| `ctx.planMode` | `core` | [`plan-mode`](../packages/plan/plan-mode) | - | - | - | 折叠已记录的计划／模式状态，在轮次边界刷新用户选择，渲染由部署方拥有的指导信息，注册 /plan，并在状态转换期间保持计划退出 schema 稳定。 |
| `ctx.agentPresets` | `core` | [`agent-preset-registry`](../packages/preset/agent-preset-registry) | - | - | - | 立即挂载 YAML 声明的 preset 版本，把 Agent 和冷读取绑定到作用域内的贡献，并保留已替换的版本，直到最后一个使用者释放它。 |
| `ctx.commands` | `core` | [`commands`](../packages/interaction/commands) | - | - | - | 插件注册直接面向人的命令，而不会把调用发送给模型。 |
| `ctx.sessionProjections` | `core` | [`session-projection`](../packages/session/session-projection) | - | [`api-session-controller`](../packages/api/session-controller), [`tool-todo`](../packages/todo/tool-todo), [`session-title`](../packages/session/session-title) | - | 各领域注册由状态驱动的折叠单元；主动驱动过程维护每个会话的水位状态，Session controller 提供 baseline 并推送发生变化的值。 |
| `ctx.sessionProjectionCache` | `core` | [`session-projection-cache`](../packages/session/session-projection-cache) | - | [`api-session-controller`](../packages/api/session-controller), [`session-query`](../packages/session-query/session-query), [`session-reference`](../packages/context/session-reference), [`subagent`](../packages/subagent/subagent) | - | 按会话持久保存投影单元状态的检查点（节流检查点，以及轮次／结束／分离时的必选检查点），并提供冷读取阶梯：缓存行加持久化尾部回放，因此列表读取永远不需要加载完整日志。 |
| `ctx.usageLedger` | `core` | [`usage-ledger`](../packages/session/usage-ledger) | - | [`client-ui-usage-dashboard`](../packages/client/ui-usage-dashboard) | - | usage-ledger 插件把已计费的尝试折叠为按天、按模型持久化的计数器；用量仪表盘宿主面把其汇总读取委托给该服务。 |
| `ctx.usageDashboard` | `core` | [`client-ui-usage-dashboard`](../packages/client/ui-usage-dashboard) | - | - | - | 用量仪表盘宿主面在 ctx.usageLedger 之上提供 usageDashboard Remote namespace；生成的 contribution 将它送到浏览器半，由浏览器半在线读取。 |
| `ctx.skills` | `seam` | [`skill`](../packages/skill/skill) | [`skill-badge`](../packages/skill/skill-badge), [`skill-filesystem`](../packages/skill/skill-filesystem), [`skill-office`](../packages/skill/skill-office) | [`tool-skill`](../packages/skill/tool-skill) | - | 合并提供方的 skill（技能）目录；tool-skill 渲染会话前缀目录，并加载完整的 skill 正文。 |
| `ctx.evolutionSkillTelemetry` | `core` | [`evolution-skill-telemetry`](../packages/skill/evolution-skill-telemetry) | - | [`evolution-skill-manage`](../packages/skill/evolution-skill-manage), [`evolution-curator`](../packages/evolution/evolution-curator) | - | telemetry 插件拥有按技能持久化的计数器、来源、pin、生命周期状态、有证据支撑的信任度、带可查询版本注册表的 SKILL.md 修订链，以及归并成本事实；evolution-skill-manage 经可选服务上报变更并读取 pin，evolution-curator 在同一存储上驱动生命周期流转并记录信任观测。 |
| `ctx.evolutionMemory` | `core` | [`evolution-memory`](../packages/evolution/evolution-memory) | - | [`evolution-reviewer`](../packages/evolution/evolution-reviewer), [`evolution-memory-context`](../packages/context/evolution-memory-context), [`command-evolution`](../packages/evolution/command-evolution) | - | evolution-memory 插件拥有按作用域持久化的记录；evolution-reviewer 与 evolution-memory-context 读写它，command-evolution 则对照它裁决暂存的批准。 |
| `ctx.evolutionReviewer` | `core` | [`evolution-reviewer`](../packages/evolution/evolution-reviewer) | - | [`command-evolution`](../packages/evolution/command-evolution) | - | evolution-reviewer 插件在后台推导经验；command-evolution 为 /refine 调用其重建，没有其他包读取该服务。 |
| `ctx.evolutionCurator` | `core` | [`evolution-curator`](../packages/evolution/evolution-curator) | - | - | - | evolution-curator 插件拥有面向技能 telemetry 的空闲触发生命周期流转；组合通过 maybeRun 提供空闲观测，仓库内没有包直接消费该服务。 |
| `ctx.evolutionHeartbeat` | `core` | [`evolution-heartbeat`](../packages/evolution/evolution-heartbeat) | - | - | - | evolution-heartbeat 插件拥有宿主级的空闲触发任务注册表；它不注册任何提示词、工具或会话事件，维护类包把各自的任务注册到它这里。 |
| `ctx.evolutionFeedback` | `core` | [`evolution-feedback`](../packages/evolution/evolution-feedback) | - | [`evolution-curator`](../packages/evolution/evolution-curator), [`evolution-dreaming`](../packages/evolution/evolution-dreaming) | - | evolution-feedback 插件按会话观测失败的工具结果，并按归因强度与会话触达范围给汇总结果分级；evolution-curator 把其决定性信号转成技能信任，evolution-dreaming 在轻量阶段读取其摘要。它不注册任何提示词、工具或会话事件。 |
| `ctx.evolutionDreaming` | `core` | [`evolution-dreaming`](../packages/evolution/evolution-dreaming) | - | - | - | evolution-dreaming 插件用六信号合成分给已记录的失败打分，并把合格的候选晋升为按作用域持久化的梦境；evolution-heartbeat 驱动该自动循环。 |
| `ctx.evolutionGraph` | `core` | [`evolution-graph`](../packages/evolution/evolution-graph) | - | - | - | evolution-graph 插件拥有按作用域持久化的实体与关系，带边界受限的遍历与一次确定性抽取；command-evolution 经 /graph 查询它。 |
| `ctx.evolutionController` | `core` | [`evolution-controller`](../packages/evolution/evolution-controller) | - | - | - | evolution-controller 插件经生成的 evolution Remote namespace 提供作用域动词与历程读模型；演进历程页面从浏览器读取它。 |
| `ctx.evolutionScorer` | `core` | [`evolution-scorer`](../packages/evolution/evolution-scorer) | - | [`evolution-optimizer`](../packages/evolution/evolution-optimizer) | - | evolution-scorer 插件让场景经已录制会话 harness 运行，并把多次尝试归纳为通过／token／墙钟时间三元组；它不写入任何内容，evolution-optimizer 读取同一裁决来判断某个候选是否胜过其基线。 |
| `ctx.evolutionCuratorStatus` | `core` | [`client-ui-evolution`](../packages/client/ui-evolution) | - | - | - | 演进历程宿主面提供向浏览器页面报告 curator 状态的 evolutionCurator Remote namespace；生成的 contribution 将它送到客户端半。 |
| `ctx.evolutionCurriculum` | `core` | [`evolution-curriculum`](../packages/evolution/evolution-curriculum) | - | [`command-evolution`](../packages/evolution/command-evolution), [`evolution-benchmark`](../packages/evolution/evolution-benchmark) | - | evolution-curriculum 插件从技能 telemetry 与轨迹存储测量能力差距，为每个差距暂存一条有依据的训练任务，并有意识地淘汰任务；command-evolution 经 /curriculum 读取它，evolution-benchmark 把其 open 提案接纳为评估任务，这里不调用模型。 |
| `ctx.evolutionBenchmark` | `core` | [`evolution-benchmark`](../packages/evolution/evolution-benchmark) | - | [`command-evolution`](../packages/evolution/command-evolution) | - | evolution-benchmark 插件从生产失败中生长评估任务：内容去重的准入，以及带污染与退役状态的 fresh → search → validation → holdout 阶梯；command-evolution 经 /benchmark 读取它，这里不调用模型。 |
| `ctx.evolutionEvaluatorHealth` | `core` | [`evolution-evaluator-health`](../packages/evolution/evolution-evaluator-health) | - | [`evolution-scorer`](../packages/evolution/evolution-scorer), [`command-evolution`](../packages/evolution/command-evolution) | - | evolution-evaluator-health 插件记录行为评估裁决，并汇总一致性、通过率漂移与误报；evolution-scorer 经可选存储记录每个裁决，command-evolution 经 /evaluators 报告它。 |
| `ctx.evolutionPopulation` | `core` | [`evolution-population`](../packages/evolution/evolution-population) | - | [`evolution-optimizer`](../packages/evolution/evolution-optimizer), [`command-evolution`](../packages/evolution/command-evolution) | - | evolution-population 插件把每一次暂存的优化器写入记录为按技能的候选，带代数编号、父代谱系与 暂存 → 通过／拒绝 生命周期；evolution-optimizer 经可选存储记录候选，command-evolution 经 /population 查看世代、谱系与已通过的精英。 |
| `ctx.evolutionModelRoutes` | `core` | [`evolution-model-routes`](../packages/evolution/evolution-model-routes) | - | [`evolution-optimizer`](../packages/evolution/evolution-optimizer), [`command-evolution`](../packages/evolution/command-evolution) | - | evolution-model-routes 插件在进化角色拓扑之上按角色保存路由指派，并带实测证据与推荐；evolution-optimizer 经可选存储记录每一次候选生成的路由与结果，command-evolution 经 /routes 列出、固定并推荐路由。 |
| `ctx.evolutionCanary` | `core` | [`evolution-canary`](../packages/evolution/evolution-canary) | - | [`evolution-optimizer`](../packages/evolution/evolution-optimizer), [`command-evolution`](../packages/evolution/command-evolution) | - | evolution-canary 插件追踪暂存技能补丁的发布状态——shadow → canary → promoted，以及 rejected／rolled-back 两个退出；evolution-optimizer 经可选存储把每一次暂存写入记录为 shadow 部署，command-evolution 经 /canary 推进部署或将其退出。 |
| `ctx.evolutionNovelty` | `core` | [`evolution-novelty-search`](../packages/evolution/evolution-novelty-search) | - | [`evolution-optimizer`](../packages/evolution/evolution-optimizer), [`command-evolution`](../packages/evolution/command-evolution) | - | evolution-novelty-search 插件按技能持久保存行为描述符档案，衡量每一次暂存写入相对该技能既往所见的新奇度；evolution-optimizer 经可选存储记录描述符，command-evolution 经 /novelty 读取档案新奇度及其压力。 |
| `ctx.evolutionStagnation` | `core` | [`evolution-stagnation`](../packages/evolution/evolution-stagnation) | - | [`evolution-optimizer`](../packages/evolution/evolution-optimizer), [`command-evolution`](../packages/evolution/command-evolution) | - | evolution-stagnation 插件统计某技能无有意义改进的评估运行次数，并在前沿停滞时点出 §32 阶梯上的下一个策略；evolution-optimizer 经可选存储把每一次暂存写入记录为一次运行，command-evolution 经 /stagnation 读取状态、运行次数与重置。 |
| `ctx.evolutionIslands` | `core` | [`evolution-islands`](../packages/evolution/evolution-islands) | - | [`evolution-optimizer`](../packages/evolution/evolution-optimizer), [`command-evolution`](../packages/evolution/command-evolution) | - | evolution-islands 插件按技能保存带 §7 目标的进化轨道、岛屿之间的迁移记录与迁移日程；evolution-optimizer 经可选存储推进代际 tick，command-evolution 经 /islands 注册轨道、记录迁移并读取日程。 |
| `ctx.evolutionSelfModel` | `core` | [`evolution-self-model`](../packages/evolution/evolution-self-model) | - | [`evolution-optimizer`](../packages/evolution/evolution-optimizer), [`command-evolution`](../packages/evolution/command-evolution) | - | evolution-self-model 插件保存按技能持久化的能力记录，并推导出说明下一步该学什么的弱优先能力前沿；evolution-optimizer 经可选存储记录能力观测，command-evolution 经 /selfmodel 读取前沿与下一步应学的差距。 |
| `ctx.evolutionUncertainty` | `core` | [`evolution-uncertainty`](../packages/evolution/evolution-uncertainty) | - | [`evolution-scorer`](../packages/evolution/evolution-scorer), [`command-evolution`](../packages/evolution/command-evolution) | - | evolution-uncertainty 插件保存分歧、低置信、不稳定、检索歧义与证据冲突这些持久的不确定性信号，并聚合为高价值评估任务的优先级队列；evolution-scorer 经可选存储记录评估器分歧，command-evolution 经 /uncertainty 读取队列。 |
| `ctx.evolutionAdversary` | `core` | [`evolution-adversary`](../packages/evolution/evolution-adversary) | - | [`command-evolution`](../packages/evolution/command-evolution) | - | evolution-adversary 插件保存横跨八个弱点类别的持久对抗探针，以及评估器博弈防御清单；command-evolution 经 /adversary 记录探针、读取下一个探测挑战并跟踪防御清单。 |
| `ctx.evolutionLineage` | `core` | [`evolution-lineage`](../packages/evolution/evolution-lineage) | - | [`evolution-optimizer`](../packages/evolution/evolution-optimizer), [`command-evolution`](../packages/evolution/command-evolution) | - | evolution-lineage 插件保存带依赖版本、可比性检查与消融归因的实验信封；evolution-optimizer 经可选存储把每一次暂存写入记录为信封，command-evolution 经 /lineage 比较并回放信封。 |
| `ctx.evolutionSleeptime` | `core` | [`evolution-sleeptime`](../packages/evolution/evolution-sleeptime) | - | [`command-evolution`](../packages/evolution/command-evolution) | - | evolution-sleeptime 插件在离线成本经济策略下保存预期未来任务及其预计算的推理产物；command-evolution 经 /sleeptime 读取该计划。 |
| `ctx.evolutionBudget` | `core` | [`evolution-budget`](../packages/evolution/evolution-budget) | - | [`evolution-optimizer`](../packages/evolution/evolution-optimizer), [`command-evolution`](../packages/evolution/command-evolution) | - | evolution-budget 插件按类别为每个候选批次定价，并以精确余量把已记录支出与该批配额结算，同时给出逐次减半的筛选日程；evolution-optimizer 经可选存储记录每一次暂存写入的配额与支出，command-evolution 经 /budget 读取批次、结算与支出。 |
| `ctx.evolutionEvaluatorStrategy` | `core` | [`evolution-evaluator-strategy`](../packages/evolution/evolution-evaluator-strategy) | - | [`evolution-optimizer`](../packages/evolution/evolution-optimizer), [`command-evolution`](../packages/evolution/command-evolution) | - | evolution-evaluator-strategy 插件按评估器与任务类别，从后续经独立真值校验的裁决中积累信任度，并据此为某个类别的评估器排序；evolution-optimizer 经可选存储把每一次暂存写入的评分器裁决与其留出真值配对，command-evolution 经 /evaluator-strategy 读取统计与排序。 |
| `ctx.evolutionMeta` | `core` | [`evolution-meta`](../packages/evolution/evolution-meta) | - | [`evolution-optimizer`](../packages/evolution/evolution-optimizer), [`command-evolution`](../packages/evolution/command-evolution) | - | evolution-meta 插件记录其算子、评估器、预算与路由选择所构成的配置下每一次引擎运行，推导各配置的通过率与平均 token 数，并推荐某任务类别下一次该采用的配置；evolution-optimizer 经可选存储记录每一次暂存写入的运行，command-evolution 经 /meta 读取运行、汇总与推荐。 |
| `ctx.evolutionMetrics` | `core` | [`evolution-metrics`](../packages/evolution/evolution-metrics) | - | [`command-evolution`](../packages/evolution/command-evolution) | - | evolution-metrics 插件在已记录的引擎运行上测量单位算力换来的能力增益，并给出失败复发、回归债、晋级、回滚与评估器可靠性的支撑读数：每项都从已计算它的存储中读取，无法测量的指标会点名缺失的记录而不是报零；command-evolution 经 /metrics 渲染一份报告。 |
| `ctx.evolutionOperators` | `core` | [`evolution-operators`](../packages/evolution/evolution-operators) | - | [`evolution-optimizer`](../packages/evolution/evolution-optimizer), [`command-evolution`](../packages/evolution/command-evolution) | - | evolution-operators 插件按算子与产物类别累计尝试次数、接受率、平均结果增量与回归率，并按探索校正后的得分给算子排序；evolution-optimizer 经可选存储记录每一次暂存写入的算子与结果，command-evolution 经 /operators 读取统计与排序。 |
| `ctx.evolutionRouter` | `core` | [`evolution-router`](../packages/evolution/evolution-router) | - | [`evolution-optimizer`](../packages/evolution/evolution-optimizer), [`command-evolution`](../packages/evolution/command-evolution) | - | evolution-router 插件按任务类别与进化角色测量路由结果，推导各路由的有效性，并为某个类别与角色排序应当使用的路由；evolution-optimizer 经可选存储记录每一次暂存写入的评估路由，command-evolution 经 /router 读取结果、有效性与推荐。 |
| `ctx.evolutionTrajectory` | `core` | [`evolution-trajectory`](../packages/evolution/evolution-trajectory) | - | - | - | evolution-trajectory 插件把一个 Session 或某个作用域的全部 Session 导出为 ShareGPT 轨迹，写入宿主路径。 |
| `ctx.evolutionTrace` | `core` | [`evolution-trace`](../packages/evolution/evolution-trace) | - | [`command-evolution`](../packages/evolution/command-evolution) | - | evolution-trace 插件把已提交的会话日志投影为结构化学习轨迹，含每次失败工具调用的排序根因归因与压缩后的学习轨迹行；command-evolution 经 /trace 读取它，这里不写入任何领域，也不发起模型请求。 |
| `ctx.evolutionRetrieval` | `core` | [`evolution-retrieval`](../packages/evolution/evolution-retrieval) | - | [`command-evolution`](../packages/evolution/command-evolution) | - | evolution-retrieval 插件记录某会话当时生效的检索配置，并以在该配置下运行过的会话的下游任务成功率为其评分，在证据门禁之上推荐每个任务类别的最佳配置；active-memory-context 记录当时生效的配置，这里既不重构检索，也不发起模型请求。 |
| `ctx.evolutionVerifiers` | `core` | [`evolution-verifiers`](../packages/evolution/evolution-verifiers) | - | [`evolution-curator`](../packages/evolution/evolution-curator) | - | evolution-verifiers 插件按最廉价优先运行候选体阶梯——模式、确定性不变量、领域仿真、评估器模型、人工复核——在第一个作出裁决的梯级停下，并把它无法自行裁决的层级委托给已挂载的 seam；evolution-curator 经它路由补丁准入，缺失的 seam 会弃权而不是伪造一次通过。 |
| `ctx.agents` | `core` | [`agent`](../packages/core/agent) | - | [`agent-loop`](../packages/core/agent-loop), [`acp`](../packages/acp/acp), [`subagent-in-process-driver`](../packages/subagent/subagent-in-process-driver) | - | 拥有实时 Agent 句柄、创建／恢复工厂 seam，以及进程本地的发起方传播。 |
| `ctx.agentDefaultModel` | `core` | [`agent-default-model`](../packages/core/agent-default-model) | - | [`api-session-controller`](../packages/api/session-controller), [`headless`](../packages/bundle/headless) | - | Reads the default ModelSelection from volatile Config and saves selections through the profile editor. |
| `ctx.agentLoop` | `bundle` | [`agent-loop`](../packages/core/agent-loop) | - | [`base`](../packages/bundle/base), [`sdk-minimal`](../packages/bundle/sdk-minimal) | - | 唯一的具体循环插件；扩展包依赖 dsh-agent 的事件和服务，而不依赖此包。 |
| `ctx.goals` | `core` | [`goal`](../packages/goal/goal) | - | - | - | 从会话日志折叠带修订版本的目标状态，并将实时延续激活保留在进程本地。 |
| `ctx.ssh` | `core` | [`ssh`](../packages/ssh/ssh) | - | [`fs-ssh`](../packages/ssh/fs-ssh), [`subprocess-ssh`](../packages/ssh/subprocess-ssh), [`sandbox-ssh`](../packages/ssh/sandbox-ssh) | - | 负责一条经过认证的 OpenSSH 连接、已安装辅助程序身份、独立程序流，以及配套远端提供方的断连清理。 |
| `ctx.subprocess` | `seam` | [`subprocess`](../packages/subprocess/subprocess) | [`subprocess-local`](../packages/subprocess/subprocess-local), [`subprocess-ssh`](../packages/ssh/subprocess-ssh) | [`bash-local`](../packages/shell/bash-local), [`bash-sandbox`](../packages/shell/bash-sandbox), [`terminal-bash`](../packages/terminal/terminal-bash), [`lsp-stdio`](../packages/lsp/lsp-stdio), [`subagent-acp`](../packages/subagent/subagent-acp), [`subagent-codex`](../packages/subagent/subagent-codex), [`subagent-claude-code`](../packages/subagent/subagent-claude-code) | - | Bash 执行器、PTY shell 后端、LSP Host，以及进程外 ACP、Codex 和 Claude Code subagent 后端都通过 ctx.subprocess 执行 spawn；该服务负责进程坐标、进程树／会话生命周期、stdio 处置、终端机制和 kill 升级。 |
| `ctx.shell` | `seam` | [`shell`](../packages/shell/shell) | [`bash-local`](../packages/shell/bash-local), [`bash-sandbox`](../packages/shell/bash-sandbox), [`pwsh-local`](../packages/shell/pwsh-local) | [`tool-bash`](../packages/shell/tool-bash), [`tool-pwsh`](../packages/shell/tool-pwsh), [`hooks-claude-code`](../packages/hooks/hooks-claude-code), [`hooks-codex`](../packages/hooks/hooks-codex) | - | 面向模型的 shell 工具和钩子桥接消费此 seam；沙箱、远程或 PowerShell 执行器可以替换 bash-local，而无需改动这些消费方。 |
| `ctx.shellEnv` | `core` | [`shell-env`](../packages/shell/shell-env) | - | [`tool-bash`](../packages/shell/tool-bash), [`tool-pwsh`](../packages/shell/tool-pwsh) | - | 插件声明限定于 effect 作用域的 DSH_* 事实；每个 shell 工具在每次执行时收集一份可信快照，其执行器据此重建命名空间。 |
| `ctx.terminals` | `seam` | [`terminal`](../packages/terminal/terminal) | [`terminal-bash`](../packages/terminal/terminal-bash) | [`tool-terminal`](../packages/terminal/tool-terminal) | - | 注册表负责精确到 Agent 的会话身份和清理；后端负责终端机制，tool-terminal 则提供限定于所有者作用域的模型接口。 |
| `ctx.sandbox` | `seam` | [`sandbox`](../packages/sandbox/sandbox) | [`sandbox-local`](../packages/sandbox/sandbox-local), [`sandbox-ssh`](../packages/ssh/sandbox-ssh) | [`bash-sandbox`](../packages/shell/bash-sandbox), [`terminal-bash`](../packages/terminal/terminal-bash) | - | 消费方交出即将执行 spawn 的确切 argv；与配套子进程提供方共享执行环境的后端按每次调用的策略包装该 argv，并报告强制执行情况。 |
| `ctx.sandboxPolicy` | `core` | [`sandbox-policy`](../packages/sandbox/sandbox-policy) | - | [`bash-sandbox`](../packages/shell/bash-sandbox), [`fs-sandbox`](../packages/fs/fs-sandbox), [`terminal-bash`](../packages/terminal/terminal-bash) | - | 统一保存部署默认模式和工作区根目录；只有沙箱执行器和提供方读取该服务（工具层使用它同时导出的纯 `sandbox/mode` 折叠区）。两类强制执行组件都读取该服务，因此 bash 与 fs 不会限制到不同的根目录。 |
| `ctx.approval` | `seam` | [`user-approval`](../packages/interaction/user-approval) | - | [`tools`](../packages/core/tools), [`tool-bash`](../packages/shell/tool-bash), [`acp`](../packages/acp/acp) | - | 一次性权限决策通过 `approval/request` waterfall（瀑布式事件）分派；回答方是监听器（即 ACP 为自身 agent 提供的桥接），没有回答方时以 `unavailable` 关闭失败。 |
| `ctx.permissionPresets` | `core` | [`permission-presets`](../packages/interaction/permission-presets) | - | - | - | 面向用户的预设表（`workspace-write`／`danger-full-access`），将沙箱模式与审批策略选项组合在一起；一次切换会写入一个 `permission/preset` 事件，并贯通到两个选项事件。 |
| `ctx.ptcRuntime` | `seam` | [`ptc-runtime`](../packages/ptc-runtime/ptc-runtime) | [`ptc-runtime-node`](../packages/ptc-runtime/ptc-runtime-node), [`experimental-ptc-runtime-python`](../packages/experimental/ptc-runtime-python) | [`tools`](../packages/core/tools), [`workflow-ptc`](../packages/workflow/workflow-ptc) | - | 使用 Host 提供的异步绑定运行程序；tools 负责 PTC 呈现，workflow-ptc 负责工作流编排。 |
| `ctx.fs` | `seam` | [`fs`](../packages/fs/fs) | [`fs-local`](../packages/fs/fs-local), [`fs-sandbox`](../packages/fs/fs-sandbox), [`fs-ssh`](../packages/ssh/fs-ssh) | [`tool-fs`](../packages/fs/tool-fs) | [`fs-observation-policy`](../packages/fs/fs-observation-policy) | tool-fs 通过 ctx.fs 执行读取／写入／编辑；fs-sandbox 按共享沙箱模式限制变更；fs-observation-policy 通过 fs/* 事件门禁贡献基于观测状态的检查。 |
| `ctx.compaction` | `seam` | [`compaction`](../packages/compaction/compaction) | [`compaction-basic`](../packages/compaction/compaction-basic) | [`compaction-basic`](../packages/compaction/compaction-basic) | - | 基础后端消费步骤后的压力事件和请求错误恢复事件；不存在面向模型的压缩工具。 |
| `ctx.subagents` | `seam` | [`subagent`](../packages/subagent/subagent) | [`subagent-spawn-in-process`](../packages/subagent/subagent-spawn-in-process), [`subagent-fork-in-process`](../packages/subagent/subagent-fork-in-process), [`subagent-acp`](../packages/subagent/subagent-acp), [`subagent-codex`](../packages/subagent/subagent-codex), [`subagent-claude-code`](../packages/subagent/subagent-claude-code), [`subagent-dsh-sdk`](../packages/subagent/subagent-dsh-sdk) | [`tool-subagent`](../packages/subagent/tool-subagent), [`tool-subagent-control`](../packages/subagent/tool-subagent-control), [`tool-ralph`](../packages/workflow/tool-ralph) | - | 提供方实现传输；该服务还负责可选的、基于 Activation 的延续编排，tool-subagent 选择一次性或可延续委派，tool-subagent-control 传递后续消息，而 tool-ralph 要求一条全新的结构化输出路由。 |
| `ctx.speechToText` | `seam` | [`experimental-speech-to-text`](../packages/experimental/speech-to-text) | [`experimental-speech-to-text-sensevoice`](../packages/experimental/speech-to-text-sensevoice) | [`experimental-api-speech-to-text`](../packages/experimental/api-speech-to-text) | - | 路由显式选择的识别器；浏览器使用带认证的 Remote，并在提交前将转写保留在草稿中。 |
| `ctx.agentTeams` | `core` | [`experimental-agent-team`](../packages/experimental/agent-team) | - | [`experimental-tool-agent-team`](../packages/experimental/tool-agent-team), [`experimental-client-ui-agent-team`](../packages/experimental/client-ui-agent-team) | - | 负责隐式 Root roster、持久 peer mailbox、共享任务 DAG、continuable child 生命周期与生成式 Team Remote method；tool-agent-team 提供模型控制工具，client-ui-agent-team 挂载浏览器 contribution。 |
| `ctx.inspector` | `core` | `inspector` | - | - | - | 负责 Worker 托管的 CDP target，以及独立于传输的 Host 和 Client observation 与 Cordis tree query API。 |
| `ctx.jobs` | `seam` | [`jobs`](../packages/jobs/jobs) | [`jobs-local`](../packages/jobs/jobs-local) | [`tool-bash`](../packages/shell/tool-bash), [`tool-pwsh`](../packages/shell/tool-pwsh), [`tool-terminal`](../packages/terminal/tool-terminal), [`tool-subagent`](../packages/subagent/tool-subagent), [`tool-jobs`](../packages/jobs/tool-jobs), [`api-job-controller`](../packages/api/job-controller) | - | 生产方（后台 bash/pwsh、PTY 发送和 subagent 委派）登记正在运行的工作；声明 record 的 job 还为非消费观察者流式提供原始输出；tool-jobs 是面向模型的控制器，用于读取、列出和终止这些工作；jobs-local 是进程本地注册表。 |
| `ctx.web` | `seam` | [`web`](../packages/web/web) | [`web-search-exa`](../packages/web/web-search-exa), [`web-search-perplexity`](../packages/web/web-search-perplexity), [`web-search-deepseek`](../packages/web/web-search-deepseek), [`web-fetch-http`](../packages/web/web-fetch-http) | [`tool-web`](../packages/web/tool-web) | - | 搜索和抓取提供方注册到同一个 ctx.web seam；tool-web 负责稳定的面向模型名称。 |
| `ctx.spillStore` | `seam` | [`spill`](../packages/spill/spill) | [`spill-local`](../packages/spill/spill-local) | [`spill-policy`](../packages/spill/spill-policy) | - | 后端保存过大的工具文本，并返回面向模型的定位信息和取回提示；spill-policy 是 tools/post-execute 消费方，负责决定何时 spill。 |
| `ctx.directoryPicker` | `seam` | [`host-directory-picker`](../packages/host/directory-picker) | [`host-directory-picker-native`](../packages/host/directory-picker-native), [`host-directory-picker-browse`](../packages/host/directory-picker-browse) | [`api-workspace-controller`](../packages/api/workspace-controller) | - | 带判别标记的交互能力：原生后端在 Host 显示设备上打开一个操作系统选择器，浏览后端为应用内浏览器提供列表与创建原语；双端后端通过其浏览器侧填充 ui-workspace 目录流程的 slot（不通过协议发布）。 |
| `ctx.webServer` | `core` | [`host-webserver`](../packages/host/webserver) | - | [`client-connection`](../packages/client/connection), [`client-modules`](../packages/client/modules), [`client-hmr`](../packages/client/hmr) | - | 普通的 node:http 载体：具名路由注册表、索引转换 tap，以及静态 dist 回退；Web 传输插件注册自己的路由。 |
| `ctx.clientModules` | `core` | [`client-modules`](../packages/client/modules) | - | [`client-hmr`](../packages/client/hmr) | - | 通过增量 `dsh.client` 扫描组合 __DSH_BOOT__ 入口图，提供插件组合包，并通知重建／图变更订阅方。 |
| `ctx.workflowEngine` | `seam` | [`workflow`](../packages/workflow/workflow) | [`workflow-ptc`](../packages/workflow/workflow-ptc) | [`tool-workflow`](../packages/workflow/tool-workflow), [`tool-ralph`](../packages/workflow/tool-ralph) | - | 每个上下文使用一个引擎，与 bash 相同，且没有具名提供方注册表；通用工作流与固定 Ralph 消费方启动运行，其中的 agent() 调用通过 ctx.subagents 扇出。 |
| `ctx.webhookRuntime` | `core` | [`webhook`](../packages/webhook/webhook) | - | [`webhook-github`](../packages/webhook/webhook-github) | - | 提供方适配器分派已认证交付；可信插件注册独立的进程本地规则，runtime 把非 null 结果转换为普通的 Workspace-backed Session，不保留交付或完成状态。 |
| `ctx.lsp` | `seam` | [`lsp`](../packages/lsp/lsp) | [`lsp-stdio`](../packages/lsp/lsp-stdio) | [`tool-lsp`](../packages/lsp/tool-lsp) | - | 提供方注册与选择，加上恰好四种操作的标准化查询执行；该 seam 不提供协议逃生口，后端必须转换为标准化请求和结果。 |
| `ctx.dynamicCordisRunner` | `core` | [`cordis-host-runner`](../packages/extensions/cordis-host-runner) | - | [`tool-cordis`](../packages/extensions/tool-cordis) | - | 拥有内存定义注册表、Host 半的 vm 沙箱和 request-run 往返流程；浏览器页面通过其 Remote 命名空间在线访问同一服务。 |
| `ctx.cordisInspect` | `core` | [`cordis-host-runner`](../packages/extensions/cordis-host-runner) | - | [`tool-cordis`](../packages/extensions/tool-cordis) | - | 注册 Host inspect 提供方、镜像 Client 提供方 manifest，并通过动态 Cordis 传输路由 Client 查询。 |

维护模式：混合模式。服务从 Cordis 声明中发现；接口、实现和消费方角色在 `scripts/gen-doc-graphs.ts` 中分类，并设有完整性守卫。
