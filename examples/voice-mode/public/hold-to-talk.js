export function bindHoldToTalkButton(button, getClient) {
  let held = false;

  const press = (event) => {
    event.preventDefault();
    if (held) return;
    const client = getClient();
    if (!client?.connected) return;
    held = true;
    client.startTurn();
  };

  const release = (event) => {
    event.preventDefault();
    if (!held) return;
    held = false;
    const client = getClient();
    if (client?.mode === "push_to_talk") client.endTurn();
  };

  const isHoldKey = (event) => event.key === " " || event.key === "Enter";
  const keydown = (event) => {
    if (!isHoldKey(event)) return;
    event.preventDefault();
    if (!event.repeat) press(event);
  };
  const keyup = (event) => {
    if (isHoldKey(event)) release(event);
  };
  const blur = (event) => {
    if (held) release(event);
  };

  button.addEventListener("pointerdown", press);
  button.addEventListener("pointerup", release);
  button.addEventListener("pointercancel", release);
  button.addEventListener("pointerleave", release);
  button.addEventListener("keydown", keydown);
  button.addEventListener("keyup", keyup);
  button.addEventListener("blur", blur);

  return () => {
    button.removeEventListener("pointerdown", press);
    button.removeEventListener("pointerup", release);
    button.removeEventListener("pointercancel", release);
    button.removeEventListener("pointerleave", release);
    button.removeEventListener("keydown", keydown);
    button.removeEventListener("keyup", keyup);
    button.removeEventListener("blur", blur);
  };
}
