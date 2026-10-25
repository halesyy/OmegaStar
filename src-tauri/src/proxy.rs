//! The usage limits of a CLI proxy's (CLIProxyAPI) Claude accounts, read through its management API.

use crate::claude::UsageSample;
use crate::model::{ProxySettings, Ts, UsageWindow};
use serde_json::{json, Value};
use std::time::Duration;

const USAGE_URL: &str = "https://api.anthropic.com/api/oauth/usage";

/// A management API call; `None` when the proxy could not be reached or refused it.
async fn management(client: &reqwest::Client, p: &ProxySettings, path: &str, body: Option<Value>) -> Option<Value> {
    let url = format!("{}/v0/management/{path}", p.url);
    let req = match body {
        Some(b) => client.post(url).json(&b),
        None => client.get(url),
    };
    let res = req.bearer_auth(&p.management_key).timeout(Duration::from_secs(15)).send().await.ok()?;
    res.error_for_status().ok()?.json().await.ok()
}

/// The pool's usage, as if it were one account. `None` when the proxy could not say; an empty sample
/// when there is no management key or no Claude account, so the office has no limits to wait for.
pub async fn usage(p: &ProxySettings) -> Option<UsageSample> {
    if p.management_key.is_empty() {
        return Some(UsageSample::default());
    }
    let client = reqwest::Client::new();
    let files = management(&client, p, "auth-files", None).await?;
    let claude: Vec<&Value> = files["files"]
        .as_array()?
        .iter()
        .filter(|f| f["provider"] == "claude" && f["disabled"] != true)
        .collect();
    let mut accounts = vec![];
    for f in &claude {
        // The proxy fills in the account's own token for `$TOKEN$`.
        let call = json!({
            "auth_index": f["auth_index"],
            "method": "GET",
            "url": USAGE_URL,
            "header": { "Authorization": "Bearer $TOKEN$", "anthropic-beta": "oauth-2025-04-20" },
        });
        let Some(res) = management(&client, p, "api-call", Some(call)).await else { continue };
        if !(200..300).contains(&res["status_code"].as_u64().unwrap_or(0)) {
            continue;
        }
        if let Ok(u) = serde_json::from_str::<Value>(res["body"].as_str().unwrap_or("")) {
            accounts.push(u);
        }
    }
    if accounts.is_empty() && !claude.is_empty() {
        return None;
    }
    Some(pool(&accounts))
}

/// Each window's use averaged over the accounts, so it is full only when every account is, and
/// resetting when the first of them does.
fn pool(accounts: &[Value]) -> UsageSample {
    let window = |k: &str| {
        let seen: Vec<(f64, Option<Ts>)> = accounts
            .iter()
            .filter_map(|a| {
                let resets = a[k]["resets_at"].as_str().and_then(|t| chrono::DateTime::parse_from_rfc3339(t).ok());
                Some((a[k]["utilization"].as_f64()?, resets.map(|t| t.to_utc())))
            })
            .collect();
        if seen.is_empty() {
            return None;
        }
        let percent = seen.iter().map(|(p, _)| p).sum::<f64>() / seen.len() as f64;
        Some(UsageWindow { percent: percent.clamp(0.0, 100.0), resets_at: seen.iter().filter_map(|(_, r)| *r).min(), resets_text: None })
    };
    UsageSample { five_hour: window("five_hour"), seven_day: window("seven_day") }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_pool_is_full_only_when_every_account_is() {
        let accounts = [
            json!({ "five_hour": { "utilization": 100.0, "resets_at": "2030-01-01T12:00:00+00:00" }, "seven_day": { "utilization": 40.0, "resets_at": null } }),
            json!({ "five_hour": { "utilization": 20.0, "resets_at": "2030-01-01T10:00:00+00:00" }, "seven_day": null }),
        ];
        let s = pool(&accounts);
        let five = s.five_hour.unwrap();
        assert_eq!(five.percent, 60.0);
        assert_eq!(five.resets_at.unwrap().to_rfc3339(), "2030-01-01T10:00:00+00:00");
        let week = s.seven_day.unwrap();
        assert_eq!((week.percent, week.resets_at), (40.0, None), "an account without the window does not count");
        assert_eq!(pool(&[]), UsageSample::default());
    }
}
