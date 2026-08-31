export default function AdminForbidden() {
  return (
    <div className="admin-access-message">
      <section>
        <p className="eyebrow">403</p>
        <h1>无权访问</h1>
        <p>当前登录账号不在管理员白名单中。</p>
      </section>
    </div>
  );
}
