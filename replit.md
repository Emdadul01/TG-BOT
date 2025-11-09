# Overview

This is a comprehensive Telegram channel manager bot built with Node.js for managing the @Simple_Minecraft channel. The bot provides complete administrative control including message management, user moderation, admin promotion, and channel information. It features password-based authentication, automated message scheduling, and intelligent message tracking for bulk operations.

# Recent Changes

**November 8, 2025** - Delete Previous Auto-Message Toggle & Translation Feature
- Added toggle button to enable/disable deleting previous auto-messages before sending new ones
- Implemented real-time translation feature that automatically translates non-English posts to English
- Translation system detects language, deletes original message, and posts English translation
- English messages are left unchanged when translation is enabled
- Both features can be toggled on/off from the bot menu and persist across restarts
- Added new Translation Settings menu accessible from main menu

**November 8, 2025** - Auto-Message Persistence & Timer Controls
- Added persistent storage for auto-message configuration (.auto_message_config.json)
- Implemented configurable timer/interval for auto-messages with 10 preset options (1 min to daily)
- Auto-message system now survives bot restarts and automatically resumes if previously active
- Added interval display in auto-message menu showing current posting frequency
- All auto-message settings (text, buttons, interval, active status) now persist across restarts

**November 8, 2025** - Auto-Message Button System
- Replaced automatic message scheduling with user-controlled button system
- Added configurable auto-message with custom text and multiple URL buttons
- Implemented start/stop controls for scheduled messages
- Added message preview functionality to see messages before sending
- Fixed state management issues to prevent stale data after cancellation
- Users can now configure messages on-demand instead of fixed automatic posting

**November 8, 2025** - Code Quality Improvements & Cleanup
- Added graceful shutdown handlers (SIGINT/SIGTERM) for proper bot cleanup on stop
- Enhanced error handling with try-catch for bot.launch() to prevent unhandled failures
- Updated package.json with descriptive name "telegram-channel-manager-bot" and proper metadata
- Added "start" script to package.json for easier deployment
- Removed unnecessary generated-icon.png file (14KB cleanup)
- Improved code organization and best practices compliance

**November 8, 2025** - Authentication Loading Bug Fix
- Fixed critical timing issue where authentication data was loaded after bot launch
- Authentication data now loads before bot starts accepting commands
- Eliminates race condition where users could be prompted for password despite being authenticated
- Ensures seamless authentication persistence across all bot restarts

**November 8, 2025** - Persistent Authentication Added
- Implemented file-based authentication persistence (.bot_auth.json)
- Authenticated users remain logged in across bot restarts
- No need to re-enter password after bot updates or restarts

**November 8, 2025** - Username Support Added
- Added username support for all user management commands (ban, unban, mute, unmute, promote, demote)
- Implemented smart user identifier resolution by tracking channel admins and post authors
- Users can now be targeted by either user ID or username (with @)
- Enhanced error messages to clarify username lookup failures
- Bot tracks usernames from channel posts and loads admin usernames on startup

**November 8, 2025** - Major Feature Expansion
- Transformed from simple message scheduler to full channel manager
- Added comprehensive command suite for message, user, and admin management
- Implemented smart message tracking system (up to 5000 messages)
- Enhanced security with required BOT_PASSWORD environment variable
- Added help command with full documentation
- Fixed HTML parsing issues and message ID tracking bugs

# User Preferences

Preferred communication style: Simple, everyday language.

# System Architecture

## Application Type
**Decision:** Standalone Node.js bot application  
**Rationale:** Single-purpose channel management application that doesn't require a web framework or database. The bot runs continuously as a process, handling Telegram interactions, executing scheduled tasks, and managing channel administration.

## Bot Framework
**Decision:** Telegraf framework for Telegram Bot API  
**Rationale:** Telegraf provides a modern, promise-based API for building Telegram bots with clean middleware support and simplified command handling. It abstracts the complexity of the Telegram Bot API while providing type safety through TypeScript definitions.

## Task Scheduling
**Decision:** node-cron for on-demand scheduled message rotation  
**Rationale:** Lightweight cron-based scheduler that runs within the Node.js process. Auto-messages are user-controlled (start/stop via buttons) with configurable intervals from 1 minute to daily. The interval setting persists across restarts, and the scheduler automatically resumes if it was active before shutdown. Messages are fully configurable with custom text and URL buttons.

## State Management
**Decision:** Hybrid in-memory and file-based storage  
**Rationale:** Current requirements include:
- `Set` for tracking authenticated users (by user ID) - **persisted to .bot_auth.json file**
- Auto-message configuration object (text, buttons, interval, active status, deletePrevious toggle) - **persisted to .channel_data.json file**
- Translation enabled/disabled state per channel - **persisted to .channel_data.json file**
- `Array` for tracking up to 5000 recent channel message IDs - in-memory only
- `Map` for username to user ID mappings - in-memory, rebuilt on startup
- Variables for tracking last automated message ID - in-memory only
- **Trade-off:** Authentication, auto-message configuration, and translation settings persist across restarts. Auto-messages automatically resume if they were active. Message tracking and username mappings rebuild automatically (message IDs from new posts, usernames from channel admins on startup). If full persistence is needed later, a database solution would be required.

## Message Tracking System
**Decision:** Automatic channel message ID tracking via channel_post events  
**Rationale:** The bot tracks message IDs as they're posted to the channel, maintaining a rolling buffer of the 5000 most recent messages. This enables the /deleteall command to work with actual channel message IDs rather than attempting to guess valid IDs. Successfully deleted or protected messages are removed from tracking, while failed deletions remain for retry.

## Authentication Approach
**Decision:** Required password-based authentication via environment variable  
**Rationale:** Single-password system (`BOT_PASSWORD`) gates access to all administrative features. The password is mandatory (fail-fast on startup if missing) to prevent unauthorized access. Users authenticate once per session, tracked in the `authenticatedUsers` Set. This is appropriate for a small-scale bot with trusted administrators.

## Message Management Strategy
**Decision:** Multi-faceted message management  
**Rationale:** 
1. **Automated Scheduling:** Delete-and-replace pattern for promotional messages keeps channel clean
2. **Manual Send:** /send command returns message ID for tracking
3. **Targeted Delete:** /delete command removes specific messages by ID
4. **Bulk Delete:** /deleteall uses tracked message IDs, skips pinned messages, and only removes successfully processed IDs from tracking

## Configuration Management
**Decision:** Environment variables with validation  
**Rationale:** 
- `BOT_TOKEN`: Telegram bot authentication token (required)
- `BOT_PASSWORD`: Admin authentication password (required, no default)
- Application validates required variables on startup and exits if missing, following fail-fast security principles

## Error Handling
**Decision:** Try-catch blocks with console logging and user feedback  
**Rationale:** Errors in all operations are caught and logged. User-facing commands provide clear success/failure messages with actionable guidance. The bot continues running even if individual operations fail due to network issues, API errors, or permission problems.

# Feature Set

## Message Management Commands
- **/send [message]** - Send a message to the channel, returns message ID
- **/delete [message_id]** - Delete a specific message by ID
- **/deleteall [limit]** - Delete tracked non-pinned messages (with smart ID removal)

## Auto-Message System
- **Set Message Text** - Configure custom message text with HTML formatting support
- **Set Timer/Interval** - Choose posting frequency (1 min, 5 min, 10 min, 15 min, 30 min, hourly, 2h, 6h, 12h, daily)
- **Add URL Button** - Create clickable URL buttons (multiple buttons supported)
- **Clear URL Buttons** - Remove all configured URL buttons
- **Delete Previous Toggle** - Enable/disable automatic deletion of previous auto-message before posting new one
- **Preview Message** - Preview how the message will look before sending
- **Start Auto-Messages** - Begin scheduled message posting at configured interval
- **Stop Auto-Messages** - Stop scheduled message posting
- All configurations persist across bot restarts

## Translation Settings
- **Enable/Disable Translation** - Toggle automatic translation of non-English posts to English
- When enabled, the bot monitors all channel posts and automatically:
  - Detects the language of the post
  - Deletes the original message if it's not in English
  - Posts an English translation of the message
  - Leaves English messages unchanged
- Translation state persists across bot restarts

## User Management Commands
- **/ban [user_id or @username]** - Ban a user from the channel
- **/unban [user_id or @username]** - Unban a user from the channel
- **/mute [user_id or @username]** - Mute a user (disable messaging)
- **/unmute [user_id or @username]** - Unmute a user (restore messaging)

## Admin Management Commands
- **/promote [user_id or @username]** - Promote user to admin with full permissions
- **/demote [user_id or @username]** - Demote admin to regular member

## Channel Information Commands
- **/info** - Get channel statistics and details
- **/admins** - List all channel administrators with roles
- **/help** - Show comprehensive command documentation

## Authentication
- **/start** - Begin authentication flow
- Password entry - Authenticate to unlock all commands

# External Dependencies

## Telegram Bot API
**Service:** Telegram's Bot API  
**Purpose:** Core messaging platform for bot interactions and channel management  
**Integration:** Via Telegraf library using bot token authentication  
**Channel:** Hardcoded to `@Simple_Minecraft`  
**Permissions Required:** Bot must be channel admin with full permissions

## NPM Packages
1. **telegraf** (v4.16.3) - Telegram bot framework
2. **node-cron** (v4.2.1) - Task scheduling
3. **@types/node** (v22.13.11) - TypeScript definitions for Node.js
4. **@vitalets/google-translate-api** - Free translation library for language detection and translation

## Runtime Requirements
**Platform:** Node.js runtime environment  
**Environment Variables Required:**
- `BOT_TOKEN` - Telegram bot API token (required)
- `BOT_PASSWORD` - Authentication password for bot access (required, no default)

## External Bot Reference
**Related Bot:** `@Simple_Minecraftbot`  
**Purpose:** Target destination promoted in automated channel messages (Minecraft mods repository)
