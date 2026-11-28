/// 端侧智能体引擎的**统一入口**（桶文件，不含任何逻辑）。
///
/// UI / 宿主只需要这一行：
/// ```dart
/// import 'package:musicbox/features/agent/agent_config.dart';   // 装配：AgentEngine / buildAgentEngine
/// import 'package:musicbox/features/agent/engine/agent_engine.dart'; // 其余全部公共类型
/// ```
///
/// 这里刻意**不导出** `agent_guardrails.dart` 的护栏实现细节与 `agent_messages.dart`
/// 的 JSON 编码细节：界面按 [AgentEvent] 渲染、按 [AgentRunResult] 收口就够，
/// 能碰的东西越少，越不容易在 UI 侧不小心把 `reasoning` 当回复渲染出去。
library;

export 'agent_errors.dart';
export 'agent_events.dart';
export 'agent_memory.dart'
    show
        AgentMemoryEntry,
        AgentMemoryStore,
        MemoryWriteResult,
        RemoteAgentMemory,
        memoryPromptBlock,
        memoryLayerViolation;
export 'agent_messages.dart' show AgentRole, AgentToolCallDto, AgentChatMessage, agentRoleWireName;
export 'agent_registry.dart' show AgentToolRegistry, AgentRegistryException;
export 'agent_runner.dart' show AgentRunner, AgentRunResult, AgentEventSink;
export 'agent_tool.dart'
    show
        AgentTool,
        AgentToolKind,
        AgentToolResult,
        ToolResult,
        AgentToolCallContext,
        validateToolArguments;
export 'agent_transport.dart'
    show
        AgentTransport,
        RemoteAgentTransport,
        AgentTransportException,
        AgentLlmReply,
        AgentLlmRequest,
        AgentUsage,
        AgentFinishReason,
        AgentHttpPost,
        AgentHttpGet,
        AgentHttpPut,
        AgentHttpDelete;

// 技能与工具：装配期需要（内置技能集、下发源、工具名常量用于文案）
export '../skills/agent_skill.dart' show AgentSkill, AgentSkillSource, kSkillRankBuiltin, kSkillRankServer, kSkillRankUser;
export '../skills/builtin_skills.dart' show kBuiltinSkills;
export '../skills/remote_skill_source.dart'
    show RemoteSkillSource, kSkillsCatalogPath, kSkillsBodyPathPrefix, kSkillsBodyRoutePattern, skillBodyPath;
export '../skills/skill_provider.dart' show SkillProvider, SkillLoadLedger, SkillBodyLoader;
export '../tools/knowledge_web_search_tool.dart'
    show
        kWebSearchToolName,
        kWebSearchPath,
        kWebSearchDomains,
        WebSearchOutcome,
        WebSearchHit,
        WebSearchQuery,
        WebSearchGateway,
        WebSearchToolOptions,
        remoteWebSearchGateway,
        buildKnowledgeWebSearchTool,
        isAllowedSearchUrl;
export '../tools/ask_tools.dart'
    show
        kAskUserToolName,
        kAskUserMaxQuestions,
        kAskUserMinOptions,
        kAskUserMaxOptions,
        AgentAskDraft,
        AgentAskRequest,
        AgentAskHandler,
        buildAskUserTool;
export '../tools/load_skill_tool.dart' show kLoadSkillToolName, buildLoadSkillTool;
export '../tools/memory_tools.dart' show kMemoryWriteToolName, kMemoryForgetToolName, buildMemoryWriteTool, buildMemoryForgetTool;
export '../tools/proposal_tools.dart'
    show
        AgentProposal,
        AgentProposalHandler,
        kProposeCardPatchToolName,
        kProposeGenerateToolName,
        kProposeMvShotReworkToolName,
        buildProposeCardPatchTool,
        buildProposeGenerateTool,
        buildProposeMvShotReworkTool;
export '../tools/query_tools.dart'
    show
        kLibrarySearchToolName,
        kJobStatusToolName,
        kCatalogLookupToolName,
        kIntentReadToolName,
        LibrarySearchFn,
        JobStatusFn,
        CatalogFn,
        IntentReadFn,
        buildLibrarySearchTool,
        buildJobStatusTool,
        buildCatalogLookupTool,
        buildIntentReadTool;
