# Attention 独立用户权限管理端设计

**状态：** 已确认，可直接实施
**日期：** 2026-08-27

## 目标

为自用测试提供同域名、独立地址的管理端。管理员可查询全部账号，并将指定用户设为 Member 或 Filter、撤销 Filter；新注册用户直接默认 Member。管理端不出现在用户端导航、账户页或跳转链路中。

## 访问与安全

- 路径为 `/admin/users`，仅由直接访问进入。
- 服务端从环境变量 `ATTENTION_ADMIN_EMAILS`（逗号分隔、规范化邮箱）判断管理员；前端隐藏不是安全边界。
- 未登录返回登录要求；非白名单账号返回 403，不泄露用户数据。
- 管理员不能通过页面授予管理员身份，也不支持批量变更。

## 页面

- 轻量列表：邮箱、显示名/Attention ID、注册时间、当前权益（Free/Member/Filter）、Filter 状态。
- 查询：邮箱、显示名、Attention ID、权益筛选；服务端分页。
- 单用户操作：设为 Member、设为 Filter、撤销 Filter；每次操作必须填写原因并有明确确认。
- 仅供自用，沿用站点基础视觉，不做用户端导航或运营仪表盘。

## 权益语义

- 新验证码注册账号创建后立即获得永久 `member_enabled` 的 `signup` entitlement。
- “设为 Member”确保账号拥有有效 Member entitlement，并撤销当前有效 Filter grant。
- “设为 Filter”保留 Member 能力并创建或恢复该账号的有效 Filter grant。
- “撤销 Filter”只撤销 Filter grant，不撤销 Member entitlement。
- 所有写入通过既有 membership / entitlement 服务和事务，避免绕过实时权益解析。

## 审计

每次管理员写操作记录操作者、目标账号、动作、变更前后权益、原因、时间及请求关联 ID；审计日志可在该用户详情中只读查看。

## 验收

1. 新注册账号默认解析为 Member。
2. 管理员白名单以外的账号无法读写 `/admin/*`。
3. 管理员可查询用户并完成 Member、Filter、撤销 Filter 三种操作。
4. 操作后权益实时生效且写入审计。
5. 用户端没有到管理端的可见链接或跳转。
