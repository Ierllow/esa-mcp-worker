import type { DomainStatus } from "./errors";

const parameterJa = {
  bodyMd: "`body_md`",
  confirmWrite: "`confirm_write`",
  domainStatus: "`domain_status`",
  expectedRevisionNumber: "`expected_revision_number`",
  heading: "`heading`",
  messageJa: "`message_ja`",
  newText: "`new_text`",
  occurrence: "`occurrence`",
  oldText: "`old_text`",
  sectionBodyMd: "`section_body_md`",
  teamName: "`team_name`",
};

type ErrorCatalogEntry = {
  messageJa: string;
  hintJa?: string;
};

export const errorCatalogJa: Record<DomainStatus, ErrorCatalogEntry> = {
  esa_auth_failed: {
    messageJa: "esaの認証に失敗しました。",
    hintJa: "MCPクライアントのOAuth接続をやり直し、有効なesa access tokenを入力してください。",
  },
  esa_token_expired: {
    messageJa: "esa access tokenの期限が切れている可能性があります。",
    hintJa: "MCPクライアントのOAuth接続をやり直し、有効なesa access tokenを入力してください。",
  },
  esa_permission_denied: {
    messageJa: "esaの権限が不足しているか、対象にアクセスできません。",
    hintJa: "team名とesa tokenの読み取り権限を確認してください。",
  },
  esa_write_permission_required: {
    messageJa: "esaへの書き込み権限が不足しています。",
    hintJa: "esa tokenにwrite権限を付けて再接続してください。",
  },
  esa_post_not_found: {
    messageJa: "指定されたesa記事が見つかりません。",
    hintJa: "post_numberが正しいか、対象記事を読める権限があるか確認してください。",
  },
  esa_resource_not_found: {
    messageJa: "esaの対象リソースが見つかりません。",
    hintJa: "team名、対象記事、endpointを確認してください。",
  },
  esa_team_or_endpoint_not_found: {
    messageJa: "esaのteamまたはendpointが見つかりません。",
    hintJa: "team名、対象endpoint、Cloudflareの設定値を確認してください。",
  },
  esa_revision_conflict: {
    messageJa: "esa記事のrevisionが変わっているため更新できません。",
    hintJa: `最新のrevisionを読み直してから、必要なら${parameterJa.expectedRevisionNumber}を更新して再実行してください。`,
  },
  revision_conflict: {
    messageJa: "esa記事のrevisionが変わっているため更新できません。",
    hintJa: `最新のrevisionを読み直してから、必要なら${parameterJa.expectedRevisionNumber}を更新して再実行してください。`,
  },
  esa_validation_failed: {
    messageJa: "esa APIが入力内容を受け付けませんでした。",
    hintJa: "入力値、write権限、revision guard、必須項目を確認してください。",
  },
  esa_rate_limited: {
    messageJa: "esa APIの利用制限に当たっています。",
    hintJa: "少し待ってから再実行してください。",
  },
  esa_unavailable: {
    messageJa: "esa APIが一時的に利用できない状態です。",
    hintJa: "時間を置いて再試行してください。",
  },
  esa_request_failed: {
    messageJa: "esa APIリクエストに失敗しました。",
    hintJa: "返却されたdetailsと入力値を確認してください。",
  },
  write_confirmation_required: {
    messageJa: `esaへの書き込みには ${parameterJa.confirmWrite}: true が必要です。`,
    hintJa: `書き込みを実行してよい場合だけ、${parameterJa.confirmWrite}: true を付けて再実行してください。`,
  },
  server_config_missing: {
    messageJa: "MCPサーバーの設定が不足しています。",
    hintJa: "Cloudflare Workerのvars/secrets/KV設定を確認してください。",
  },
  team_required: {
    messageJa: "esaのteam名が必要です。",
    hintJa: `${parameterJa.teamName}を渡すか、ESA_DEFAULT_TEAMを設定してください。`,
  },
  observer_required: {
    messageJa: "context observerがCloudflare KVに設定されていません。",
    hintJa: "管理画面で監視対象を追加するか、esa_refresh_context_observerで旧observerを一度だけ移行してください。",
  },
  observer_json_missing: {
    messageJa: "移行元のcontext observerにJSONブロックがありません。",
    hintJa: "旧observer記事のbaselineブロックを確認してください。移行後はesa記事を使いません。",
  },
  observer_json_invalid: {
    messageJa: "context observerの保存内容が正しくありません。",
    hintJa: "管理画面で設定を修正するか、旧observerから再移行してください。",
  },
  registry_required: {
    messageJa: "現役ページregistryの記事番号が設定されていません。",
    hintJa: "registry_post_numberを渡すか、ESA_ACTIVE_PAGE_REGISTRY_POST_NUMBERを設定してください。",
  },
  registry_yaml_missing: {
    messageJa: "現役ページregistryにYAML blockがありません。",
    hintJa: "対象記事に一つのyaml code blockを置いてください。",
  },
  registry_yaml_invalid: {
    messageJa: "現役ページregistryのYAMLまたはschemaが正しくありません。",
    hintJa: "registry_version、scope、pagesと各pageの値を確認してください。",
  },
  invalid_input: {
    messageJa: "入力内容が正しくありません。",
  },
  empty_update: {
    messageJa: "更新する内容が指定されていません。",
    hintJa: "name、body_md、tags、category、wip、messageのいずれかを指定してください。",
  },
  bulk_update_limit_exceeded: {
    messageJa: "一度にまとめて更新できる記事数の上限を超えています。",
    hintJa: "`posts`を上限以下の件数に分けて再実行してください。",
  },
  bulk_create_limit_exceeded: {
    messageJa: "一度にまとめて作成できる記事数の上限を超えています。",
    hintJa: "`posts`を上限以下の件数に分けて再実行してください。",
  },
  bulk_create_payload_too_large: {
    messageJa: "まとめて作成する記事の合計サイズが大きすぎます。",
    hintJa: "postsを小分けにするか、本文が大きい記事はesa_create_postで個別に作成してください。",
  },
  bulk_create_aborted: {
    messageJa: "続きの記事作成は送信せずに中断しました。",
    hintJa: "直前の認証、権限、利用制限エラーを解消してから未送信の記事を再実行してください。",
  },
  multi_search_limit_exceeded: {
    messageJa: "一度に実行できる検索数の上限を超えています。",
    hintJa: "`queries`を上限以下の件数に分けて再実行してください。",
  },
  bulk_duplicate_post_number: {
    messageJa: "同じpost_numberがまとめて更新の対象に複数含まれています。",
    hintJa: "postsの各post_numberが重複しないようにしてください。",
  },
  bulk_payload_too_large: {
    messageJa: "まとめて更新する内容の合計サイズが大きすぎます。",
    hintJa: "postsを小分けにするか、本文が大きい記事はesa_update_postやesa_patch_postで個別に更新してください。",
  },
  bulk_update_aborted: {
    messageJa: "続きの記事更新は送信せずに中断しました。",
    hintJa: "直前の認証、権限、利用制限エラーを解消してから未送信の記事を再実行してください。",
  },
  category_move_no_change: {
    messageJa: "移動元と移動先のcategoryが同じです。",
    hintJa: "`from`と`to`に異なるcategory pathを指定してください。",
  },
  body_required: {
    messageJa: "本文が必要です。",
    hintJa: `${parameterJa.bodyMd}を指定してください。`,
  },
  search_query_required: {
    messageJa: "検索語が必要です。",
    hintJa: "searchコマンドには検索語を入れてください。",
  },
  command_target_not_found: {
    messageJa: "コマンドから対象記事を特定できませんでした。",
    hintJa: "#123、post 123、comments 123、search keyword のように対象を指定してください。",
  },
  heading_required: {
    messageJa: "見出し名が必要です。",
    hintJa: `replace_sectionでは${parameterJa.heading}を指定してください。`,
  },
  section_body_required: {
    messageJa: "sectionの本文が必要です。",
    hintJa: `replace_sectionでは${parameterJa.sectionBodyMd}を指定してください。`,
  },
  patch_text_required: {
    messageJa: "置換する文字列が不足しています。",
    hintJa: `replace_textでは${parameterJa.oldText}と${parameterJa.newText}を指定してください。`,
  },
  section_not_found: {
    messageJa: "指定された見出しセクションが見つかりません。",
    hintJa: `先にoutlineを確認し、見出し名と${parameterJa.occurrence}を合わせてください。`,
  },
  patch_target_not_found: {
    messageJa: "置換対象の文字列が見つかりません。",
    hintJa: `${parameterJa.oldText}が現在の本文と一致しているか確認してください。`,
  },
  patch_target_ambiguous: {
    messageJa: "置換対象の文字列が複数見つかりました。",
    hintJa: `${parameterJa.occurrence}を指定して、どの一致箇所を置換するか選んでください。`,
  },
  patch_no_change: {
    messageJa: "patch後の本文に変更がありません。",
    hintJa: `${parameterJa.oldText}/${parameterJa.newText}やsection本文を確認してください。`,
  },
  section_patch_overlap: {
    messageJa: "指定されたsection patchが重複しています。",
    hintJa: "同じ範囲を複数回置換しないようにsection指定を分けてください。",
  },
  github_not_connected: {
    messageJa: "GitHub認証が設定されていません。",
    hintJa: "対象repositoryだけにインストールしたGitHub Appを設定してください。",
  },
  github_app_config_invalid: {
    messageJa: "GitHub Appの設定が不足しています。",
    hintJa: "GITHUB_APP_ID、GITHUB_APP_INSTALLATION_ID、GITHUB_APP_PRIVATE_KEYをすべて設定してください。",
  },
  github_app_token_failed: {
    messageJa: "GitHub Appのinstallation tokenを取得できませんでした。",
    hintJa: "App ID、installation ID、秘密鍵、repositoryへのインストール状態を確認してください。",
  },
  github_auth_failed: {
    messageJa: "GitHubの認証に失敗しました。",
    hintJa: "GitHub Appのinstallation、App ID、秘密鍵を確認してください。",
  },
  github_permission_denied: {
    messageJa: "GitHub repositoryを更新する権限がありません。",
    hintJa: "GitHub AppにContents read/write、Checks read、Commit statuses readがあるか確認してください。",
  },
  github_repository_not_found: {
    messageJa: "設定されたGitHub repositoryが見つかりません。",
    hintJa: "GITHUB_REPOSITORYとGitHub Appのinstallation対象を確認してください。",
  },
  github_resource_not_found: {
    messageJa: "GitHub上の対象fileまたはbranchが見つかりません。",
    hintJa: "path、branch、SHAが現在のrepositoryと一致しているか確認してください。",
  },
  github_ref_conflict: {
    messageJa: "同じ名前のGitHub branchが存在するか、referenceを作成できません。",
    hintJa: "新しい作業branch名で再実行してください。",
  },
  github_file_conflict: {
    messageJa: "GitHub fileが読み取り後に変更されています。",
    hintJa: "最新のrepository snapshotとfileを読み直してから再実行してください。",
  },
  github_protected_path: {
    messageJa: "自動更新を許可していないpathです。",
    hintJa: "workflow、環境変数、秘密鍵などの設定は手動で変更してください。",
  },
  github_payload_too_large: {
    messageJa: "一度に更新するfile数または合計サイズが上限を超えています。",
    hintJa: "変更を小さく分け、関係しないfileを含めずに再実行してください。",
  },
  github_validation_pending: {
    messageJa: "GitHub上の実装チェックがまだ完了していません。",
    hintJa: "同じbranchとhead SHAでstatusをもう一度確認してください。",
  },
  github_validation_failed: {
    messageJa: "GitHub上の実装チェックに失敗しました。",
    hintJa: "失敗したcheckを確認し、同じ変更をそのまま公開せず修正してください。",
  },
  github_validation_missing: {
    messageJa: "実装を公開するためのGitHub checkが見つかりません。",
    hintJa: "Cloudflare Workers Buildsの非本番branch buildとbuild対象pathを確認してください。",
  },
  github_publish_conflict: {
    messageJa: "確認中にdefault branchが更新されたため公開を中止しました。",
    hintJa: "最新のdefault branchを読み直し、変更を作り直してください。force updateは行いません。",
  },
  github_api_failed: {
    messageJa: "GitHub APIリクエストに失敗しました。",
    hintJa: "返却されたstatusとdetailsを確認してください。",
  },
  tool_failed: {
    messageJa: "MCPツールの実行に失敗しました。",
  },
  cloudflare_kv_write_blocked: {
    messageJa: "Cloudflare Workers KVの書き込み上限に達しています。",
    hintJa: "日次リセットを待つか、audit設定をnone/minimalに下げるか、Workers Paid planへの変更を検討してください。",
  },
  cloudflare_runtime_error: {
    messageJa: "Cloudflare Workerの実行中にエラーが発生しました。",
    hintJa: "Cloudflare Workerのログ、bindings、KVの状態を確認してください。",
  },
  server_unexpected_error: {
    messageJa: "MCPサーバーで予期しないエラーが発生しました。",
    hintJa: "返却されたcode/domain_statusを確認し、Workerログを確認してください。",
  },
};

export function messageJaFor(domainStatus: DomainStatus, fallback: string) {
  return errorCatalogJa[domainStatus]?.messageJa ?? fallback;
}

export function hintJaFor(domainStatus: DomainStatus) {
  return errorCatalogJa[domainStatus]?.hintJa;
}
