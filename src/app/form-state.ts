export function formSaved(form: HTMLFormElement) {
  form.dispatchEvent(new Event('erp:form-saved', { bubbles: true }));
}
export function requestFormLeave() {
  return document.dispatchEvent(new Event('erp:request-leave', { cancelable: true }));
}
