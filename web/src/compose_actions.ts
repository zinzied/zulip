/* Module primarily for opening/closing the compose box. */

import autosize from "autosize";
import $ from "jquery";
import _ from "lodash";

import * as blueslip from "./blueslip.ts";
import * as compose_banner from "./compose_banner.ts";
import * as compose_fade from "./compose_fade.ts";
import * as compose_notifications from "./compose_notifications.ts";
import * as compose_pm_pill from "./compose_pm_pill.ts";
import * as compose_recipient from "./compose_recipient.ts";
import * as compose_state from "./compose_state.ts";
import * as compose_tooltips from "./compose_tooltips.ts";
import * as compose_ui from "./compose_ui.ts";
import type {ComposeTriggeredOptions} from "./compose_ui.ts";
import * as compose_validate from "./compose_validate.ts";
import * as drafts from "./drafts.ts";
import * as message_lists from "./message_lists.ts";
import type {Message} from "./message_store.ts";
import * as message_util from "./message_util.ts";
import type {ShowMessageViewOpts} from "./message_view.ts";
import * as message_viewport from "./message_viewport.ts";
import * as narrow_state from "./narrow_state.ts";
import {page_params} from "./page_params.ts";
import * as popovers from "./popovers.ts";
import * as reload_state from "./reload_state.ts";
import * as resize from "./resize.ts";
import * as saved_snippets_ui from "./saved_snippets_ui.ts";
import * as spectators from "./spectators.ts";
import * as stream_data from "./stream_data.ts";
import * as util from "./util.ts";

// Opts sent to `compose_actions.start`.
type ComposeActionsStartOpts = {
    message_type: "private" | "stream";
    force_close?: boolean;
    trigger?: string;
    private_message_recipient_ids?: number[];
    message?: Message | undefined;
    stream_id?: number | undefined;
    topic?: string;
    content?: string;
    draft_id?: string;
    skip_scrolling_selected_message?: boolean;
    is_reply?: boolean;
    keep_composebox_empty?: boolean | undefined;
    defer_focus?: boolean | undefined;
};

// An iteration on `ComposeActionsStartOpts` that enforces that
// some values are present.
type ComposeActionsOpts = ComposeActionsStartOpts & {
    topic: string;
    private_message_recipient_ids: number[];
    trigger: string;
};

type ComposeHook = () => void;

const compose_clear_box_hooks: ComposeHook[] = [];
const compose_cancel_hooks: ComposeHook[] = [];

export function register_compose_box_clear_hook(hook: ComposeHook): void {
    compose_clear_box_hooks.push(hook);
}

export function register_compose_cancel_hook(hook: ComposeHook): void {
    compose_cancel_hooks.push(hook);
}

function call_hooks(hooks: ComposeHook[]): void {
    for (const f of hooks) {
        f();
    }
}

export let blur_compose_inputs = (): void => {
    $(".message_comp").find("input, textarea, button, #private_message_recipient").trigger("blur");
};

export function rewire_blur_compose_inputs(value: typeof blur_compose_inputs): void {
    blur_compose_inputs = value;
}

function hide_box(): void {
    // This is the main hook for saving drafts when closing the compose box.
    drafts.update_draft();
    blur_compose_inputs();
    $("#compose_recipient_box").hide();
    $("#compose-direct-recipient").hide();
    $(".new_message_textarea").css("min-height", "");
    compose_fade.clear_compose();
    $(".message_comp").hide();
    $("#compose_controls").show();
    // Assume a muted recipient row for the next time
    // the compose box is reopened
    $("#compose-recipient").addClass("low-attention-recipient-row");
    $("#compose").removeClass("compose-box-open");
}

function show_compose_box(opts: ComposeActionsOpts): void {
    let opts_by_message_type: ComposeTriggeredOptions;
    if (opts.message_type === "private") {
        opts_by_message_type = {
            trigger: opts.trigger,
            message_type: "private",
            private_message_recipient_ids: opts.private_message_recipient_ids,
        };
    } else {
        opts_by_message_type = {
            trigger: opts.trigger,
            message_type: "stream",
            stream_id: opts.stream_id,
            topic: opts.topic,
        };
    }
    compose_recipient.update_compose_for_message_type(opts_by_message_type);
    // When changing this, edit the 42px in _maybe_autoscroll
    $(".new_message_textarea").css("min-height", "3em");
    // Under certain circumstances, such as focusing in the
    // automatically-opened compose box in DMs, we want to
    // defer running the focus logic.
    if (opts.defer_focus) {
        setTimeout(() => {
            compose_ui.set_focus(opts_by_message_type);
        }, 0);
    } else {
        compose_ui.set_focus(opts_by_message_type);
    }
    // Transitions in the recipient row of the compose box are attached
    // to this class we add a slight delay to avoid transitions firing
    // immediately.
    requestAnimationFrame(() => {
        $("#compose").addClass("compose-box-open");
    });
}

export let clear_textarea = (): void => {
    $("#compose").find("input[type=text], textarea").val("");
};

export function rewire_clear_textarea(value: typeof clear_textarea): void {
    clear_textarea = value;
}

function clear_box(): void {
    call_hooks(compose_clear_box_hooks);

    // TODO: Better encapsulate at-mention warnings.
    compose_validate.clear_topic_resolved_warning();
    compose_validate.clear_stream_wildcard_warnings($("#compose_banners"));
    compose_validate.clear_guest_in_dm_recipient_warning();
    compose_validate.set_user_acknowledged_stream_wildcard_flag(false);

    compose_state.set_recipient_edited_manually(false);
    compose_state.set_is_content_unedited_restored_draft(false);
    clear_textarea();
    compose_validate.check_overflow_text($("#send_message_form"));
    drafts.set_compose_draft_id(undefined);
    $("textarea#compose-textarea").toggleClass("invalid", false);
    compose_ui.autosize_textarea($("textarea#compose-textarea"));
    compose_banner.clear_errors();
    compose_banner.clear_warnings();
    compose_banner.clear_uploads();
    $(".needs-empty-compose").removeClass("disabled-on-hover");
    // Reset send button status.
    $("#compose-send-button").removeClass("disabled-message-send-controls");
}

let autosize_callback_opts: ComposeActionsStartOpts;
export let autosize_message_content = (opts: ComposeActionsStartOpts): void => {
    if (!compose_ui.is_expanded()) {
        autosize_callback_opts = opts;
        let has_resized_once = false;
        $("textarea#compose-textarea")
            .off("autosize:resized")
            .on("autosize:resized", (e) => {
                if (!has_resized_once) {
                    has_resized_once = true;
                    maybe_scroll_up_selected_message(autosize_callback_opts);
                }
                const height = $(e.currentTarget).height()!;
                const max_height = Number.parseFloat($(e.currentTarget).css("max-height"));
                // We add 5px to account for minor differences in height detected in Chrome.
                if (height + 5 >= max_height) {
                    $("#compose").addClass("automatically-expanded");
                } else {
                    $("#compose").removeClass("automatically-expanded");
                }
            });
        autosize($("textarea#compose-textarea"));
    }
};

export function rewire_autosize_message_content(value: typeof autosize_message_content): void {
    autosize_message_content = value;
}

export let expand_compose_box = (): void => {
    $("#compose_close").attr("data-tooltip-template-id", "compose_close_tooltip_template");
    $("#compose_controls").hide();
    $(".message_comp").show();
};

export function rewire_expand_compose_box(value: typeof expand_compose_box): void {
    expand_compose_box = value;
}

export let complete_starting_tasks = (opts: ComposeActionsOpts): void => {
    // This is sort of a kitchen sink function, and it's called only
    // by compose.start() for now.  Having this as a separate function
    // makes testing a bit easier.

    maybe_scroll_up_selected_message(opts);
    compose_fade.start_compose(opts.message_type);
    $(document).trigger(new $.Event("compose_started.zulip", opts));
    compose_recipient.update_compose_area_placeholder_text();
    compose_recipient.update_narrow_to_recipient_visibility();
    compose_recipient.update_recipient_row_attention_level();

    // This logic catches the corner case of starting a new topic
    // from within an existing *general chat* topic via buttons
    // in the left sidebar and collapsed compose box as well as
    // the compose hotkey, ensuring that we have a high-attention
    // recipient row.
    const new_topic_triggers = ["clear topic button", "compose_hotkey"];
    const is_new_topic_triggered = new_topic_triggers.includes(opts.trigger);

    if (is_new_topic_triggered) {
        compose_recipient.set_high_attention_recipient_row();
    }
    // We explicitly call this function here apart from compose_setup.js
    // as this helps to show banner when responding in an interleaved view.
    // While responding, the compose box opens before fading resulting in
    // the function call in compose_setup.js not displaying banner.
    if (!narrow_state.narrowed_by_reply()) {
        compose_notifications.maybe_show_one_time_interleaved_view_messages_fading_banner();
    }
    compose_ui.maybe_show_scrolling_formatting_buttons("#message-formatting-controls-container");
    compose_validate.validate_and_update_send_button_status();
};

export function rewire_complete_starting_tasks(value: typeof complete_starting_tasks): void {
    complete_starting_tasks = value;
}

export function maybe_scroll_up_selected_message(opts: ComposeActionsStartOpts): void {
    if (opts.skip_scrolling_selected_message) {
        return;
    }

    if (message_lists.current === undefined) {
        return;
    }

    // If the compose box is obscuring the currently selected message,
    // scroll up until the message is no longer occluded.
    if (message_lists.current.selected_id() === -1) {
        // If there's no selected message, there's no need to
        // scroll the compose box to avoid it.
        return;
    }
    const $selected_row = message_lists.current.selected_row();

    if ($selected_row.height()! > message_viewport.height() - 100) {
        // For very tall messages whose height is close to the entire
        // height of the viewport, don't auto-scroll the viewport to
        // the end of the message (since that makes it feel annoying
        // to work with very tall messages).  See #8941 for details.
        return;
    }

    const cover =
        $selected_row.get_offset_to_window().bottom - $("#compose").get_offset_to_window().top;
    if (cover > 0) {
        message_viewport.user_initiated_animate_scroll(cover + 20);
    }
}

export function fill_in_opts_from_current_narrowed_view(
    opts: ComposeActionsStartOpts,
): ComposeActionsOpts {
    return {
        stream_id: undefined,
        topic: "",
        private_message_recipient_ids: [],
        trigger: "unknown",

        // Set default parameters based on the current narrowed view.
        ...narrow_state.set_compose_defaults(),

        // Set parameters based on provided opts, overwriting
        // those set based on current narrowed view, if necessary.
        ...opts,
    };
}

function same_recipient_as_before(opts: ComposeActionsOpts): boolean {
    return (
        compose_state.get_message_type() === opts.message_type &&
        ((opts.message_type === "stream" &&
            opts.stream_id === compose_state.stream_id() &&
            opts.topic === compose_state.topic()) ||
            (opts.message_type === "private" &&
                _.isEqual(
                    new Set(opts.private_message_recipient_ids),
                    new Set(compose_state.private_message_recipient_ids()),
                )))
    );
}

export let start = (raw_opts: ComposeActionsStartOpts): void => {
    if (page_params.is_spectator) {
        spectators.login_to_access();
        return;
    }

    if (!raw_opts.message_type) {
        // We prefer callers to be explicit about the message type, but
        // we if we don't know, we open a stream compose box by default,
        // which opens stream selection dropdown.
        // Also, message_type is used to check if compose box is open in compose_state.composing().
        raw_opts.message_type = "stream";
        blueslip.warn("Empty message type in compose.start");
    }

    popovers.hide_all();
    autosize_message_content(raw_opts);

    if (reload_state.is_in_progress()) {
        return;
    }
    compose_banner.clear_message_sent_banners();
    expand_compose_box();

    const opts = fill_in_opts_from_current_narrowed_view(raw_opts);
    const is_clear_topic_button_triggered = opts.trigger === "clear topic button";

    // If we are invoked by a compose hotkey (c or x) or new topic
    // button, do not assume that we know what the message's topic or
    // direct message recipient should be.
    if (
        opts.trigger === "compose_hotkey" ||
        is_clear_topic_button_triggered ||
        opts.trigger === "new direct message"
    ) {
        opts.topic = "";
        opts.private_message_recipient_ids = [];
    }

    const subbed_streams = stream_data.subscribed_subs();
    if (
        subbed_streams.length === 1 &&
        subbed_streams[0] !== undefined &&
        (is_clear_topic_button_triggered ||
            (opts.trigger === "compose_hotkey" && opts.message_type === "stream"))
    ) {
        opts.stream_id = subbed_streams[0].stream_id;
    }

    // If we go to a different narrow or there is new message content to populate the compose box
    // with (like from a draft), save any existing content as a draft, and clear the compose box.
    if (
        compose_state.composing() &&
        (!same_recipient_as_before(opts) || opts.content !== undefined)
    ) {
        drafts.update_draft();
        clear_box();
    }

    if (opts.message_type === "private") {
        compose_state.set_compose_recipient_id(compose_state.DIRECT_MESSAGE_ID);
        compose_recipient.on_compose_select_recipient_update();
    } else if (opts.stream_id && opts.topic) {
        compose_state.set_stream_id(opts.stream_id);
        compose_state.topic(opts.topic);
        compose_recipient.on_compose_select_recipient_update();
    } else if (opts.stream_id) {
        const stream = stream_data.get_sub_by_id(opts.stream_id);
        if (stream && stream_data.can_post_messages_in_stream(stream)) {
            compose_state.set_stream_id(opts.stream_id);
            compose_recipient.on_compose_select_recipient_update();
        } else {
            opts.stream_id = undefined;
            compose_state.set_stream_id("");
            opts.topic = "";
            compose_recipient.toggle_compose_recipient_dropdown();
        }
    } else {
        // Open stream selection dropdown if no stream is selected.
        compose_state.set_stream_id("");
        compose_recipient.toggle_compose_recipient_dropdown();
    }
    compose_recipient.update_topic_displayed_text(opts.topic);

    compose_state.private_message_recipient_ids(opts.private_message_recipient_ids);

    // If we're not explicitly opening a different draft, restore the last
    // saved draft (if it exists).
    let restoring_last_draft = false;
    if (
        compose_state.can_restore_drafts() &&
        !opts.content &&
        opts.draft_id === undefined &&
        compose_state.message_content().length === 0 &&
        !opts.keep_composebox_empty
    ) {
        const possible_last_draft = drafts.get_last_restorable_draft_based_on_compose_state();
        if (possible_last_draft !== undefined) {
            restoring_last_draft = true;
            opts.draft_id = possible_last_draft.id;
            // Add a space at the end so that if the user starts typing
            // as soon as the composebox opens, they have a bit of separation
            // from the restored draft. This won't result in a long trail of
            // spaces if a draft is restored several times, because we trim
            // whitespace whenever we save drafts.
            opts.content = possible_last_draft.content + " ";
        }
    }

    if (opts.content !== undefined) {
        const replace_all_without_undo_support = true;
        compose_ui.insert_and_scroll_into_view(
            opts.content,
            $("textarea#compose-textarea"),
            false,
            replace_all_without_undo_support,
        );
        $(".needs-empty-compose").addClass("disabled-on-hover");
        // If we were provided with message content, we might need to
        // display that it's too long.
        compose_validate.check_overflow_text($("#send_message_form"));
    }
    // This has to happen after we insert the content, so that the next "input" event
    // is from user input.
    if (restoring_last_draft) {
        compose_state.set_is_content_unedited_restored_draft(true);
    }

    compose_state.set_message_type(opts.message_type);

    // Show either stream/topic fields or "You and" field.
    show_compose_box(opts);

    if (opts.draft_id) {
        drafts.set_compose_draft_id(opts.draft_id);
    }

    // Show a warning if topic is resolved
    compose_validate.warn_if_topic_resolved(true);
    // Show a warning if dm recipient contains guest
    compose_validate.warn_if_guest_in_dm_recipient();
    // Show a warning if the user is in a search narrow when replying to a message
    if (opts.is_reply) {
        compose_validate.warn_if_in_search_view();
    }

    compose_recipient.check_posting_policy_for_compose_box();
    drafts.update_compose_draft_count();

    // Reset the `max-height` property of `compose-textarea` so that the
    // compose-box do not cover the last messages of the current stream
    // while writing a long message.
    resize.reset_compose_message_max_height();
    compose_tooltips.initialize_compose_tooltips("compose", "#compose .compose_button_tooltip");

    complete_starting_tasks(opts);

    saved_snippets_ui.setup_saved_snippets_dropdown_widget_if_needed();
};

export function rewire_start(value: typeof start): void {
    start = value;
}

export let cancel = (): void => {
    // As user closes the compose box, restore the compose box max height
    if (compose_ui.is_expanded()) {
        compose_ui.make_compose_box_original_size();
    }

    $("textarea#compose-textarea").height(40 + "px");

    if (page_params.narrow !== undefined) {
        // Never close the compose box in narrow embedded windows, but
        // at least clear the topic and unfade.
        compose_fade.clear_compose();
        if (page_params.narrow_topic !== undefined) {
            compose_state.topic(page_params.narrow_topic);
        } else {
            compose_state.topic("");
        }
        return;
    }
    hide_box();
    clear_box();
    compose_banner.clear_message_sent_banners();
    compose_banner.clear_non_interleaved_view_messages_fading_banner();
    compose_banner.clear_interleaved_view_messages_fading_banner();
    call_hooks(compose_cancel_hooks);
    compose_state.set_message_type(undefined);
    compose_pm_pill.clear();
    $(document).trigger("compose_canceled.zulip");
};

export function rewire_cancel(value: typeof cancel): void {
    cancel = value;
}

export function on_show_navigation_view(): void {
    /* This function dictates the behavior of the compose box
     * when navigating to a view, as opposed to a narrow. */

    // Leave the compose box closed if it was already closed.
    if (!compose_state.composing()) {
        return;
    }

    // Leave the compose box open if there is content or if the recipient was edited.
    if (compose_state.has_novel_message_content() || compose_state.is_recipient_edited_manually()) {
        return;
    }

    // Otherwise, close the compose box.
    cancel();
}

export let on_topic_narrow = (): void => {
    if (!compose_state.composing()) {
        // If our compose box is closed, then just
        // leave it closed, assuming that the user is
        // catching up on their feed and not actively
        // composing.
        return;
    }

    if (compose_state.stream_name() !== narrow_state.stream_name()) {
        // If we changed streams, then we only leave the
        // compose box open if there is content or if the recipient was edited.
        if (
            compose_state.has_novel_message_content() ||
            compose_state.is_recipient_edited_manually()
        ) {
            compose_fade.update_message_list();
            return;
        }

        // Otherwise, avoid a mix.
        cancel();
        return;
    }

    if (
        ((compose_state.topic() || stream_data.can_use_empty_topic(compose_state.stream_id())) &&
            compose_state.has_message_content()) ||
        compose_state.is_recipient_edited_manually()
    ) {
        // If the user has written something to a different topic or edited it,
        // they probably want that content, so leave compose open.
        //
        // This effectively uses the heuristic of whether there is
        // content in compose or the topic was edited to determine whether
        // the user had firmly decided to compose to the old topic or is
        // just looking to reply to what they see.
        compose_fade.update_message_list();
        return;
    }

    // If we got this far, then the compose box has the correct stream
    // filled in, and either compose is empty or no topic was set, so
    // we should update the compose topic to match the new narrow.
    // See #3300 for context--a couple users specifically asked for
    // this convenience.
    compose_recipient.update_topic_displayed_text(narrow_state.topic());
    compose_validate.warn_if_topic_resolved(true);
    compose_fade.set_focused_recipient("stream");
    compose_fade.update_message_list();
    drafts.update_compose_draft_count();
    $("textarea#compose-textarea").trigger("focus");
};

export function rewire_on_topic_narrow(value: typeof on_topic_narrow): void {
    on_topic_narrow = value;
}

export type NarrowActivateOpts = {
    change_hash: boolean;
    show_more_topics: boolean;
} & ShowMessageViewOpts;

export function on_narrow(opts: NarrowActivateOpts): void {
    // We use force_close when jumping between direct message narrows with
    // the "p" key, so that we don't have an open compose box that makes
    // it difficult to cycle quickly through unread messages.
    if (opts.force_close) {
        // This closes the compose box if it was already open, and it is
        // basically a noop otherwise.
        cancel();
        return;
    }

    if (opts.trigger === "narrow_to_compose_target") {
        compose_fade.update_message_list();
        return;
    }

    if (narrow_state.narrowed_by_topic_reply()) {
        on_topic_narrow();
        return;
    }

    if (compose_state.has_novel_message_content() || compose_state.is_recipient_edited_manually()) {
        compose_fade.update_message_list();
        return;
    }

    if (narrow_state.narrowed_by_pm_reply()) {
        const filled_in_opts = fill_in_opts_from_current_narrowed_view({
            ...opts,
            message_type: "private",
        });
        // Do not open compose box if an invalid recipient is present.
        if (filled_in_opts.private_message_recipient_ids.length === 0) {
            if (compose_state.composing()) {
                cancel();
            }
            return;
        }
        // Do not open compose box if sender is not allowed to send direct message.
        const recipient_ids_string = util
            .sorted_ids(filled_in_opts.private_message_recipient_ids)
            .join(",");

        if (
            recipient_ids_string &&
            !message_util.user_can_send_direct_message(recipient_ids_string)
        ) {
            // If we are navigating between direct message conversation,
            // we want the compose box to close for non-bot users.
            if (compose_state.composing()) {
                cancel();
            }
            return;
        }

        start({
            message_type: "private",
            // Skip attempting an animated adjustment to scroll
            // position, which is useless because we are called before
            // the narrowing process has set the view's scroll
            // position. recenter_view is responsible for taking the
            // open compose box into account when placing the
            // selecting message.
            skip_scrolling_selected_message: true,
            // Defer setting focus on the compose box to avoid a
            // whole-screen scrolling bug on iPad/Safari.
            defer_focus: true,
        });
        return;
    }

    // If we got this far, then we assume the user is now in "reading"
    // mode, so we close the compose box to make it easier to use navigation
    // hotkeys and to provide more screen real estate for messages.
    cancel();
}
