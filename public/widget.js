/*!
 * DeskPilot contact form widget.
 *
 * Usage (paste where the form should appear):
 *   <script src="https://YOUR-APP/widget.js" data-org="ORG_KEY" async></script>
 *
 * Optional attributes:
 *   data-target="#contact"     CSS selector to render into (default: right after the script tag)
 *   data-title="Get in touch"  Heading text ("" hides it)
 *   data-button="Send"         Button text
 *   data-color="#1f57c9"       Accent colour
 *   data-phone="false"         Hide the phone field
 *   data-success="Thanks! ..." Message shown after sending
 */
(function () {
  "use strict";

  var script =
    document.currentScript ||
    (function () {
      var all = document.querySelectorAll("script[data-org]");
      return all[all.length - 1];
    })();
  if (!script) return;

  var orgKey = script.getAttribute("data-org") || "";
  if (!/^[a-f0-9]{32}$/.test(orgKey)) {
    console.error("[DeskPilot] Missing or invalid data-org attribute on the widget script.");
    return;
  }

  var endpoint;
  try {
    endpoint = new URL("/api/leads/" + orgKey, script.src).toString();
  } catch {
    return;
  }

  function attr(name, fallback) {
    var v = script.getAttribute(name);
    return v === null ? fallback : v;
  }

  var title = attr("data-title", "Get in touch");
  var buttonText = attr("data-button", "Send message");
  var successText = attr("data-success", "Thanks! We got your message and will reply shortly.");
  var showPhone = attr("data-phone", "true") !== "false";
  var color = attr("data-color", "#1f57c9");
  if (!/^#[0-9a-fA-F]{3,8}$/.test(color)) color = "#1f57c9";

  var host = document.createElement("div");
  host.className = "deskpilot-widget";
  var targetSelector = script.getAttribute("data-target");
  var target = targetSelector ? document.querySelector(targetSelector) : null;
  if (target) target.appendChild(host);
  else if (script.parentNode) script.parentNode.insertBefore(host, script.nextSibling);
  else document.body.appendChild(host);

  var root = host.attachShadow ? host.attachShadow({ mode: "open" }) : host;

  var style = document.createElement("style");
  style.textContent =
    ":host{all:initial;display:block}" +
    ".dp{font-family:system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#0f172a;max-width:480px;" +
    "border:1px solid #e2e8f0;border-radius:10px;padding:20px;background:#fff;box-sizing:border-box}" +
    ".dp *{box-sizing:border-box}" +
    ".dp h3{margin:0 0 12px;font-size:18px;font-weight:600}" +
    ".dp label{display:block;font-size:13px;font-weight:500;margin:10px 0 4px;color:#334155}" +
    ".dp input,.dp textarea{width:100%;font:inherit;font-size:14px;padding:9px 10px;border:1px solid #cbd5e1;border-radius:6px;background:#fff;color:#0f172a}" +
    ".dp input:focus,.dp textarea:focus{outline:2px solid " + color + "33;border-color:" + color + "}" +
    ".dp textarea{min-height:110px;resize:vertical}" +
    ".dp button{margin-top:14px;width:100%;padding:10px 14px;border:0;border-radius:6px;background:" + color +
    ";color:#fff;font:inherit;font-size:14px;font-weight:600;cursor:pointer}" +
    ".dp button[disabled]{opacity:.6;cursor:wait}" +
    ".dp .err{color:#b91c1c;font-size:12px;margin-top:4px;min-height:0}" +
    ".dp .msg{margin-top:12px;font-size:14px}" +
    ".dp .ok{color:#047857}" +
    ".dp .hp{position:absolute;left:-10000px;width:1px;height:1px;overflow:hidden}";
  root.appendChild(style);

  var uid = "dp" + Math.random().toString(36).slice(2, 8);
  function field(name, label, type, required, extra) {
    return (
      '<label for="' + uid + name + '">' + label + (required ? "" : " (optional)") + "</label>" +
      (type === "textarea"
        ? '<textarea id="' + uid + name + '" name="' + name + '"' + (required ? " required" : "") + ' maxlength="5000"></textarea>'
        : '<input id="' + uid + name + '" name="' + name + '" type="' + type + '"' + (required ? " required" : "") + (extra || "") + ">") +
      '<div class="err" data-for="' + name + '"></div>'
    );
  }

  var wrapper = document.createElement("div");
  wrapper.className = "dp";
  var heading = document.createElement("h3");
  heading.textContent = title;
  if (title) wrapper.appendChild(heading);

  var form = document.createElement("form");
  form.setAttribute("novalidate", "");
  form.innerHTML =
    field("name", "Name", "text", false, ' maxlength="120" autocomplete="name"') +
    field("email", "Email", "email", true, ' maxlength="254" autocomplete="email"') +
    (showPhone ? field("phone", "Phone", "tel", false, ' maxlength="40" autocomplete="tel"') : "") +
    field("message", "How can we help?", "textarea", true) +
    '<div class="hp" aria-hidden="true"><label>Website<input name="website" tabindex="-1" autocomplete="off"></label></div>' +
    '<button type="submit"></button><div class="msg" role="status" aria-live="polite"></div>';
  var button = form.querySelector("button");
  button.textContent = buttonText;
  var msg = form.querySelector(".msg");
  wrapper.appendChild(form);
  root.appendChild(wrapper);

  function setErrors(fields) {
    var errs = form.querySelectorAll(".err");
    for (var i = 0; i < errs.length; i++) {
      var name = errs[i].getAttribute("data-for");
      errs[i].textContent = (fields && fields[name]) || "";
    }
  }

  form.addEventListener("submit", function (ev) {
    ev.preventDefault();
    setErrors(null);
    msg.textContent = "";
    msg.className = "msg";

    var data = {};
    var inputs = form.querySelectorAll("input,textarea");
    for (var i = 0; i < inputs.length; i++) {
      if (inputs[i].value) data[inputs[i].name] = inputs[i].value;
    }
    if (!data.email || !data.message) {
      setErrors({
        email: data.email ? "" : "Please enter your email",
        message: data.message ? "" : "Please write a message",
      });
      return;
    }
    data.source = "form";

    button.disabled = true;
    fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
      credentials: "omit",
      mode: "cors",
    })
      .then(function (res) {
        return res
          .json()
          .catch(function () {
            return {};
          })
          .then(function (body) {
            return { status: res.status, body: body };
          });
      })
      .then(function (r) {
        if (r.status >= 200 && r.status < 300) {
          form.reset();
          msg.className = "msg ok";
          msg.textContent = successText;
          return;
        }
        if (r.status === 422 && r.body && r.body.fields) setErrors(r.body.fields);
        msg.textContent = (r.body && r.body.error) || "Something went wrong. Please try again.";
      })
      .catch(function () {
        msg.textContent = "Network error. Please try again.";
      })
      .then(function () {
        button.disabled = false;
      });
  });
})();
