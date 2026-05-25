# 协议分析报告：www.anything.com

## 一、平台概述

这是一个**低代码应用构建平台**（类似 Plasmic/Locofy），基于 Next.js 19 + React 19 构建，使用 Electron 桌面客户端（anything-analyzer/3.6.9）。用户通过 Google OAuth 登录后，在可视化编辑器中构建 Web/Mobile 应用，后端提供 GraphQL API、云端开发服务器（e2b sandbox）、Feature Flags（LaunchDarkly）和支付（Stripe）。

---

## 二、完整 API 端点清单

### 2.1 核心业务 API（GraphQL）

端点：`POST /api/graphql`
Content-Type: `application/json`
鉴权：`authorization` header + `Cookie: lS_authToken=...`

| 操作名 | 类型 | 变量 | 响应结构 |
|--------|------|------|----------|
| `GetProjectsForComponentSelection` | Query | `search: String`, `groupId: ID!` | `{projects: {pageInfo, edges: [{node: {id, name, previewURL, revisionToRender}}]}}` |
| `GetCustomTagData` | Query | `organizationId: ID!`, `projectGroupId: ID!`, `dataStoreInput`, `asetInput` | `{dataStores, assets, functions, userDatabases, pages}` |
| `ProjectGroupHasContent` | Query | `projectGroupId: ID!` | `{projectGroupById: {id, hasModules, hasDatabases, hasRevision}}` |
| `GetPageIdFromPathAndRuntime` | Query | `projectGroupId: ID!`, `pathSegment: String!`, `runtime: RuntimeEnvironment!` | `{projectGroupById: {id, pageForPathAndRuntime: {id}}` |
| `BootDevServer` | Mutation | `input: {projectGroupId: ID!}` | `{bootDevServer: {success, devServerSession: {id, status, webUrl, mobileUrl, healthCheckUrl}}` |
| `Me` | Query | (无) | `{me: {id, email, roles, badges, displayName, username, profile, createdAt, completedSurvey}}` |
| `GetUsersInOrganization` | Query | `id: ID!` | `{organizationById: {id, name, users: [{id, email, organizationUser: {role}, profile}], invites, organizationRole}}` |
| `GetProjectGroups` | Query | `organizationId: ID!`, `input: ProjectGroupsInput!` | `{organizationById: {creditBalance, plan}, projectGroups: {pageInfo, edges: [{node: ProjectGroupForDashboard}]}}` |
| `GetAggregatedUsageByOrganizationId` | Query | `id: ID!`, `startDate: DateTimeISO!`, `endDate: DateTimeISO!` | `{organizationById: {aggregatedIntegrationCreditUsageBySubType, aggregatedCreditUsageByType}}` |

### 2.2 监控 API（Sentry 代理）

端点：`POST /monitoring?o=1154715&p=4505287138803712`
Content-Type: `text/plain;charset=UTF-8`

实际转发到 `https://o154715.ingest.sentry.io/4505287138803712`，包含：
- Session 上报（init/crashed/ok）
- Error 事件（TypeError、WebSocket error、AbortError）
- Replay 录制（被 429 限流）
- Client Report（discarded_events 统计）

### 2.3 Feature Flags（LaunchDarkly）

| 方法 | 端点 | 说明 |
|------|------|
| GET | `https://app.launchdarkly.com/sdk/goals/63eed64fea558a138113f767` | 获取目标配置 |
| GET | `https://app.launchdarkly.com/sdk/evalx/63eed64fea558a138113f767/contexts/{base64_context}` | 评估所有 Feature Flags |
| POST | `https://events.launchdarkly.com/events/bulk/63eed64fea558a138113f767` | 上报 Flag 使用事件 |

Context 结构（base64 解码）：
```json
{"kind":"multi","user":{"key":"7578af3e-f47e-48b5-a416-6667e09fe610","firstName":"杰","lastName":"纸","email":"jiezhi858@gmail.com"}}
```

### 2.4 开发服务器健康检查

| 方法 | 端点 | 说明 |
|------|------|------|
| HEAD | `https:/{projectGroupId}.web.createdevserver.com/` | Web 预览可用性 |
| HEAD | `https://{projectGroupId}.mobile.createdevserver.com/` | Mobile 预览可用性 |
| GET | `https://{projectGroupId}.web.createdevserver.com/` | 加载 Web 预览页面 |

### 2.5 Stripe 支付集成

| 方法 | 端点 | 说明 |
|------|------|
| GET | `https://js.stripe.com/v3/controller-with-preconnect-*.html` | Stripe 控制器 iframe |
| GET | `https://js.stripe.com/v3/m-outer-*.html` | Stripe 指纹采集 iframe |

### 2.6 Next.js RSC 预取

| 方法 | 端点 | 说明 |
|------|------|---|
| GET | `/build/{projectId}?_rsc={hash}` | 项目构建页面 RSC payload |
| GET | `/dashboard/team/{orgId}/{subpage}?_rsc={hash}` | Dashboard 子页面 RSC payload |

`_rsc` 参数由 `crypto.subtle.digest("SHA-256", ...)` 对路由树结构计算后 `btoa()` 编码生成。

---

## 三、鉴权流程

### 3.1 Token 体系

```
┌────────────────────────────────┐
│  Cookie: lS_authToken (JWT HS256)                           │
│  有效期: 15 分钟 (exp - iat = 900s)                          │
│  Payload: {sub: userId, iat, exp}                           │
│  用途: GraphQL API 鉴权 (同时放在 authorization header)       │
├────────────────────────────────┤
│  Cookie: refresh_token (JWT HS256)                          │
│  有效期: ~1 年 (exp - iat ≈ 31557618s)                       │
│  Payload: {sub: userId, tokenVersion, iat, exp}             │
│  用途: 静默刷新 authToken                    │
│  特征: 每 ~12-32 秒自动刷新 (观察到 iat 持续递增)              │
├────────────────────────────────┤
│  Cookie: lS_lastSignedInWith = "google"                     │
│  用途: 记录登录方式                                          │
├────────────────────────────────┤
│  Cookie: dub_id = "jc7cocSYLCSpJNdd"                        │
│  用途: 设备/访客标识                                         │
└────────────────────────────────┘
```

### 3.2 Token 刷新机制

客户端通过 `atob()` 解码 JWT payload检查过期时间，在过期前主动刷新：

```
atob("eyJzdWIiOiI3NTc4YWYzZS1mNDdlLTQ4YjUtYTQxNi02NjY3ZTA5ZmU2MTAiLCJpYXQiOjE3Nzk2ODM1MzksImV4cCI6MTc3OTY4NDQzOX0=")
→ {"sub":"7578af3e-f47e-48b5-a416-6667e09fe610","iat":1779683539,"exp":1779684439}
```

观察到 refresh_token 的 `iat` 值在会话期间持续变化：
- 1779683557 → 1779683561 → 1779683586 → 1779683618 → 1779683638 → 1779683650 → 1779683682 → 1779683714 → 1779683746 → 1779683764 → 1779683771 → 1779683772

这表明存在**滑动窗口刷新**：每次使用 refresh_token 时服务端签发新的 refresh_token（通过 Set-Cookie 响应头）。

### 3.3 鉴权传递方式

GraphQL 请求同时通过两个通道传递 authToken：
1. `Cookie: lS_authToken=<jwt>`
2. `authorization: <jwt>`（无 Bearer 前缀）

### 3.4 Cookie 可用性检测

客户端频繁执行 localStorage/Cookie 可用性测试：
```javascript
document.cookie = "lS___test=1; Path=/"
document.cookie = "lS___test=; Max-Age=-1; Path=/"  // 立即删除
```

---

## 四、请求依赖链

```
Google OAuth 登录
    │
    ▼
[Set-Cookie: lS_authToken, refresh_token]
    │
    ├──▶ GetProjectsForComponentSelection(groupId) ──▶ 获取组件列表
    │
    ├──▶ GetCustomTagData(organizationId, projectGroupId) ──▶ 获取数据源/资产/函数
    │
    ├──▶ ProjectGroupHasContent(projectGroupId) ──▶ 检查项目是否有内容
    │         │
    │         ▼ (hasModules=false, hasRevision=false)
    │
    ├──▶ GetPageIdFromPathAndRuntime(projectGroupId, "/", "REACT") ──▶ null (无页面)
    │
    ├──▶ BootDevServer(projectGroupId) ──▶ 获取 devServerSession
    │         │
    │         ▼ 返回 webUrl, mobileUrl, healthCheckUrl
    │
    │    HEAD {projectGroupId}.web.createdevserver.com ──▶ 200 (可用)
    │    HEAD {projectGroupId}.mobile.createdevserver.com ──▶ 200 (可用)
    │    GET  {projectGroupId}.web.createdevserver.com ──▶ 加载预览
    │
    ├──▶ [导航到 Dashboard]
    │
    ├──▶ Me() ──▶ 获取用户信息 (id, email, roles)
    │         │
    │         ▼ userId → LaunchDarkly context
    │
    ├──▶ LaunchDarkly evalx(context) ──▶ 获取所有 Feature Flags
    │
    ├──▶ GetUsersInOrganization(orgId) ──▶ 团队成员列表
    │
    ├──▶ GetProjectGroups(orgId) ──▶ 项目列表 + creditBalance + plan
    │
    └──▶ GetAggregatedUsageByOrganizationId(orgId, startDate, endDate) ──▶ 用量统计
```

---

## 五、数据模型推断

```
User
├── id: UUID
├── email: String
├── roles: [String] ("CUSTOMER")
├── badges: [String]
├── displayName: String
├── username: String?
├── createdAt: DateTime
├── completedSurvey: Boolean
└── profile: UserProfile
    ├── firstName, lastName: String
    ├── photoURL: String?
    └── xUsername, instagramUsername, githubUsername, linkedinUsername, tiktokUsername: String?

Organization
├── id: UUID
├── name: String
├── plan: String ("FREE_USAGE")
├── creditBalance: String (大整数, "221935428000")
├── organizationRole: String ("OWNER")
├── users: [User] (with OrganizationUser.role)
└── invites: [Invite]

ProjectGroup
├── id: UUID
├── name: String
├── organizationId: UUID
├── hasModules: Boolean
├── hasDatabases: Boolean
├── hasRevision: Boolean
├── filesystemVersion: String
├── slug: String
├── publishingState: String
├── createdAt, updatedAt: DateTime
├── createdBy: User
├── domains: [Domain]
└── projects: [Project] (for preview)

Project
├── id: UUID
├── name: String
├── moduleType: Enum (COMPONENT, FUNCTION, PAGE)
├── previewURL: String
└── revisionToRender: Revision {id, updatedAt}

DevServerSession
├── id: String ("{projectGroupId}:BUILDER")
├── status: String ("RUNNING")
├── webUrl: String (e2b-foxtrot.dev)
├── mobileUrl: String
└── healthCheckUrl: String

CreditUsage
├── total: String (大整数)
└── usages: [{amount, average, type subType}]
    type: GENERATION_USAGE | INTEGRATION_USAGE | FAST_APPLY_USAGE
```

---

## 六、加密操作分析

### 6.1 JWT Payload 解码（atob）
客户端定期解码 authToken 的 payload段检查 `exp` 字段，判断是否需要刷新。

### 6.2 Next.js RSC 缓存键生成（crypto.subtle.digest SHA-256）
用于生成 `_rsc` 查询参数，确保 React Server Components 的缓存一致性：

```javascript
// 输入: 路由树序列化字符串 (hex encoded)
crypto.subtle.digest("SHA-256", routeTreeBuffer)
// 输出: hash hex string → btoa() → _rsc 参数
// 例: "1ba39b9f3533e2d4..." → btoa(binary) → "G6ObnzUz4tTR-X4e"
```

### 6.3 观察到的错误

分析工具尝试 hook `window.fetch` 时触发了反复的错误：
```
TypeError: Cannot assign to read only property 'fetch' of object '#<Window>'
```
这说明网站使用了 `Object.defineProperty` 将 `fetch` 设为不可写，作为一种防篡改措施。

---

## 七、复现代码

```python
"""
www.anything.com API 调用复现
需要有效的 authToken 和 refresh_token
"""
import requests json
from datetime import datetime, timezone

# ============ 配置 ============
BASE_URL = "https://www.anything.com"
AUTH_TOKEN = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiI3NTc4YWYzZS1mNDdlLTQ4YjUtYTQxNi02NjY3ZTA5ZmU2MTAiLCJpYXQiOjE3Nzk2ODM1MzksImV4cCI6MTc3OTY4NDQzOX0.dmMUcSsKYaP_bjHoQFftds3s-rBTF_ySZ0mhKGffCXA"
REFRESH_TOKEN = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiI3NTc4YWYzZS1mNDdlLTQ4YjUtYTQxNi02NjY3ZTA5ZmU2MTAiLCJ0b2tlblZlcnNpb24iOiI5YTIzZWI5Yy0wMG1LTQ5MTYtOTI1OC1kNTk2MTY3YzQzMzYiLCJpYXQiOjE3Nzk2ODM3zIsImV4cCI6MTgxMTI0MTM3Mn0.ZPrEhW8SEV1mBI58sDc6cv4EOiaT-wXyYuhDweYJYIY"

ORGANIZATION_ID = "bc55eefd-35b1-4bce-9a8e-d97d7109e8fc"
PROJECT_GROUP_ID = "3c5ab146-2dba-41f6-a03c-16d41122a330"

# ============ Session 设置 ============
session = requests.Session()
session.headers.update({
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.6998.205 Safari/537.36",
    "Origin": BASE_URL,
    "Content-Type": "application/json",
})
session.cookies.set("lS_authToken", AUTH_TOKEN, domain="www.anything.com")
session.cookies.set("refresh_token", REFRESH_TOKEN, domain="www.anything.com")
session.cookies.set("lS_lastSignedInWith", "google", domain="www.anything.com")
session.cookies.set("lS_devServerDomain", "createdevserver.com", domain="www.anything.com")


def graphql_request(operations, referer_path="/"):
    """发送 GraphQL 请求（支持批量操作）"""
    url = f"{BASE_URL}/api/graphql"
    headers = {
        "authorization": AUTH_TOKEN,
        "Referer": f"{BASE_URL}{referer_path}",
    }
    # operations 可以是单个 dict 或 list
    payload = operations if isinstance(operations, list) else [operations]
    resp = session.post(url, json=payload, headers=headers)
    resp.raise_for_status()
    return resp.json()


# ============ 1. 获取当前用户信息 ============
def get_me():
    op = {
        "operationName": "Me",
        "variables": {},
        "extensions": {"clientLibrary": {"name": "@apollo/client", "version": "4.1.6"}},
        "query": """query Me {
  me {
    id
    email
    roles
    badges
    displayName
    username
    profile {
      firstName
      lastName
      photoURL
      __typename
    }
    createdAt
    completedSurvey
    __typename
  }
}"""
    }
    result = graphql_request(op, "/dashboard/team/" + ORGANIZATION_ID)
    print("== 当前用户 ===")
    print(json.dumps(result[0]["data"]["me"], indent=2, ensure_ascii=False))
    return result[0]["data"]["me"]


# ============ 2. 获取组织信息和项目列表 ============
def get_organization_and_projects():
    ops = [
        {
            "operationName": "GetUsersInOrganization",
            "variables": {"id": ORGANIZATION_ID},
            "extensions": {"clientLibrary": {"name": "@apollo/client", "version": "4.1.6"},
            "query": """query GetUsersInOrganization($id: ID!) {
  organizationById(id: $id) {
    id
    name
    users {
      id
      email
      displayName
      organizationUser(organizationId: $id) {
        role
        __typename
      }
      __typename
    }
    invites {
      id
      toEmail
      expiresAt
      __typename
    }
    organizationRole
    __typename
  }
}"""
        },
        {
            "operationName": "GetProjectGroups",
            "variables": {
                "organizationId": ORGANIZATION_ID,
                "input": {
                    "organizationId": ORGANIZATION_ID,
                    "query": None,
                    "orderBy": {"field": "UPDATED_AT", "direction": "DESC"},
                    "createdByUserId": None
                }
            },
            "extensions": {"clientLibrary": {"name": "@apollo/client", "version": "4.1.6"}},
            "query": """query GetProjectGroups($organizationId: ID!, $input: ProjectGroupsInput!) {
  organizationById(id: $organizationId) {
    id
    creditBalance
    plan
    __typename
  }
  projectGroups(input: $input) {
    pageInfo {
      hasNextPage
      endCursor
      __typename
    }
    edges {
      node {
        id
        name
        organizationId
        createdAt
        updatedAt
        slug
        publishingState
        __typename
      }
      __typename
    }
    __typename
  }
}"""
        }
    ]
    result = graphql_request(ops, f"/dashboard/team/{ORGANIZATION_ID}")
    print("\n== 组织信息 ===")
    print(json.dumps(result[0]["data"]["organizationById"], indent=2, ensure_ascii=False))
    print("\n=== 项目列表 ===")
    if "projectGroups" in result[1].get("data", {}):
        print(json.dumps(result[1]["data"]["projectGroups"], indent=2, ensure_ascii=False))
    return result


# ============ 3. 检查项目内容状态 ============
def check_project_content(project_group_id):
    op = {
        "operationName": "ProjectGroupHasContent",
        "variables": {"projectGroupId": project_group_id},
        "extensions": {"clientLibrary": {"name": "@apollo/client", "version": "4.1.6"}},
        "query": """query ProjectGroupHasContent($projectGroupId: ID!) {
  projectGroupById(id: $projectGroupId) {
    id
    hasModules
    hasDatabases
    hasRevision
    __typename
  }
}"""
    }
    result = graphql_request(op, f"/build/{project_group_id}")
    print(f"\n=== 项目内容状态 ({project_group_id}) ===")
    print(json.dumps(result[0]["data"], indent=2))
    return result[0]["data"]


# ============ 4. 启动开发服务器 ============
def boot_dev_server(project_group_id):
    op = {
        "operationName": "BootDevServer",
        "variables": {"input": {"projectGroupId": project_group_id}},
        "extensions": {"clientLibrary": {"name": "@apollo/client", "version": "4.1.6"}},
        "query": """mutation BootDevServer($input: BootDevServerInput!) {
  bootDevServer(input: $input) {
    success
    devServerSession {
      id
      status
      webUrl
      mobileUrl
      healthCheckUrl
      __typename
    }
    __typename
  }
}"""
    }
    result = graphql_request(op, f"/build/{project_group_id}")
    print("\n=== 开发服务器 ===")
    session_data = result["data"]["bootDevServer"]
    print(json.dumps(session_data, indent=2))
    return session_data


# ============ 5. 检查开发服务器可用性 ============
def check_dev_server_health(project_group_id):
    web_url = f"https://{project_group_id}.web.createdevserver.com"
    mobile_url = f"https://{project_group_id}.mobile.createdevserver.com"

    print("\n=== 开发服务器健康检查 ===")
    for label, url in [("Web", web_url), ("Mobile", mobile_url)]:
        try:
            resp = session.head(url, timeout=10)
            print(f"  {label}: {resp.status_code}")
        except Exception as e:
            print(f"  {label}: ERROR - {e}")


# ============ 6. 获取用量统计 ============
def get_usage(org_id):
    now = datetime.now(timezone.utc)
    start = now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
    # 简化: 使用固定日期范围
    op = {
        "operationName": "GetAggregatedUsageByOrganizationId",
        "variables": {
            "id": org_id,
            "startDate": "2026-04-30T16:00:00.000Z",
            "endDate": "2026-05-31T15:59:59.999Z"
        },
        "extensions": {"clientLibrary": {"name": "@apollo/client", "version": "4.1.6"}},
        "query": """query GetAggregatedUsageByOrganizationId($id: ID!, $startDate: DateTimeISO!, $endDate: DateTimeISO!) {
  organizationById(id: $id) {
    id
    aggregatedCreditUsageByType(startDate: $startDate, endDate: $endDate) {
      total
      usages {
        amount
        average
        type
        subType
        __typename
      }
      __typename
    }
    __typename
  }
}"""
    }
    result = graphql_request(op, f"/dashboard/team/{org_id}/subscription")
    print("\n=== 用量统计 ===")
    print(json.dumps(result[0]["data"], indent=2))
    return result[0]["data"]


# ============ 7. 获取页面路由 ============
def get_page_for_path(project_group_id, path="/", runtime="REACT"):
    op = {
        "operationName": "GetPageIdFromPathAndRuntime",
        "variables": {
            "projectGroupId": project_group_id,
            "pathSegment": path,
            "runtime": runtime
        },
        "extensions": {"clientLibrary": {"name": "@apollo/client", "version": "4.1.6"}},
        "query": """query GetPageIdFromPathAndRuntime($projectGroupId: ID!, $pathSegment: String!, $runtime: RuntimeEnvironment!) {
  projectGroupById(id: $projectGroupId) {
    id
    pageForPathAndRuntime(pathSegment: $pathSegment, runtime: $runtime) {
      id
      __typename
    }
    __typename
  }
}"""
    }
    result = graphql_request(op, f"/build/{project_group_id}")
    print(f"\n=== 页面路由 (path={path}, runtime={runtime}) ===")
    print(json.dumps(result[0]["data"], indent=2))
    return result[0]["data"]


# ============ 主流程 ============
if __name__ == "__main__":
    print("=" * 60)
    print("www.anything.com API 复现")
    print("=" * 60)

    # 步骤 1: 获取用户信息
    user = get_me()

    # 步骤 2: 获取组织和项目
    org_data = get_organization_and_projects()

    # 步骤 3: 检查项目内容
    content = check_project_content(PROJECT_GROUP_ID)

    # 步骤 4: 获取页面路由
    page = get_page_for_path(PROJECT_GROUP_ID)

    # 步骤 5: 启动开发服务器
    # dev_session = boot_dev_server(PROJECT_GROUP_ID)

    # 步骤 6: 健康检查
    check_dev_server_health(PROJECT_GROUP_ID)

    # 步骤 7: 用量统计
    usage = get_usage(ORGANIZATION_ID)
```

---

## 八、关键发现与安全观察

1. **Token 刷新频率异常高**：refresh_token 每 ~12-32 秒刷新一次（观察到 10+ 次），可能是 WebSocket 重连触发或前端轮询机制。

2. **Sentry 监控代理**：网站将 Sentry 上报通过 `/monitoring` 路径代理，隐藏了真实的 Sentry DSN 端点，但 body 中仍暴露了完整 DSN（`82a20b49f37b49f5bf870d1469666dc`）。

3. **反篡改机制**：`window.fetch` 被设为只读属性，导致分析工具的 hook 反复失败并触发 Sentry 错误上报。

4. **WebSocket 连接失败**：观察到多次 "WebSocket error occurred" 错误，可能是开发服务器的实时同步通道不稳定。

5. **Feature Flags 泄露**：LaunchDarkly 响应暴露了大量内部功能开关名称（`ai-agents-enabled`、`agent-delegation-enabled