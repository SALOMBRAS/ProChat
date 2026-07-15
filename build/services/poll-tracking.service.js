const crypto = require('crypto');

/**
 * Poll Tracking Service
 * Handles storing and tracking poll messages, options, and votes
 */
class PollTrackingService {
  constructor(databaseService) {
    this.db = databaseService;
    this.logger = console;
  }

  /**
   * Store a sent poll message in the database
   */
  async storePollMessage(pollData) {
    try {
      const {
        messageId,
        sessionId,
        senderJid,
        recipientJid,
        pollQuestion,
        pollOptions,
        selectableCount = 1,
        campaignId = null,
        templateId = null,
        sentAt = new Date().toISOString()
      } = pollData;


      // Insert poll message
      const pollMessageResult = await this.db.query(`
        INSERT INTO poll_messages (
          message_id, session_id, sender_jid, recipient_jid, 
          poll_question, poll_options, selectable_count, 
          campaign_id, template_id, sent_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [
        messageId, sessionId, senderJid, recipientJid,
        pollQuestion, JSON.stringify(pollOptions), selectableCount,
        campaignId, templateId, sentAt
      ]);

      if (!pollMessageResult.success) {
        console.error('❌ POLL TRACKING: Error storing poll message:', pollMessageResult.error);
        return null;
      }

      const pollMessageId = pollMessageResult.data.lastID;

      // Store poll options with hashes
      for (let i = 0; i < pollOptions.length; i++) {
        const option = pollOptions[i];
        const optionText = typeof option === 'string' ? option : option.text;
        const optionHash = crypto.createHash('sha256').update(optionText).digest('hex');

        await this.db.query(`
          INSERT INTO poll_options (
            poll_message_id, option_text, option_index, option_hash
          ) VALUES (?, ?, ?, ?)
        `, [pollMessageId, optionText, i, optionHash]);
      }

      return pollMessageId;

    } catch (error) {
      console.error('❌ POLL TRACKING: Error storing poll message:', error);
      return null;
    }
  }

  /**
   * Store poll votes from WhatsApp - PROPER BAILEYS IMPLEMENTATION ONLY
   */
  async storePollVotes(voteData) {
    try {
      const {
        pollMessageId,
        pollResults,
        pollUpdates = []
      } = voteData;


      // Get poll options for this poll
      const optionsResult = await this.db.query(`
        SELECT id, option_text, option_hash, option_index FROM poll_options
        WHERE poll_message_id = ?
        ORDER BY option_index
      `, [pollMessageId]);

      if (!optionsResult.success || !optionsResult.data) {
        console.error('❌ POLL TRACKING: Could not find poll options for poll:', pollMessageId);
        return false;
      }

      const pollOptions = Array.isArray(optionsResult.data) ? optionsResult.data :
                         (optionsResult.data.values || []);


      // ONLY use the aggregated poll results from Baileys - NO FALLBACKS
      if (!pollResults || !Array.isArray(pollResults) || pollResults.length === 0) {
        console.error('❌ POLL TRACKING: No aggregated poll results available from Baileys - vote processing failed');
        return false;
      }


      for (const result of pollResults) {
        const { name: optionText, voters } = result;

        // Find the matching poll option
        const matchingOption = pollOptions.find(opt =>
          opt.option_text === optionText
        );

        if (!matchingOption) {
          continue;
        }


        // Store each voter's vote
        for (const voterJid of voters) {
          // Check if this vote already exists
          const existingVoteResult = await this.db.query(`
            SELECT id FROM poll_votes
            WHERE poll_message_id = ? AND voter_jid = ? AND poll_option_id = ?
          `, [pollMessageId, voterJid, matchingOption.id]);

          const voteExists = existingVoteResult.success &&
                            existingVoteResult.data &&
                            ((Array.isArray(existingVoteResult.data) && existingVoteResult.data.length > 0) ||
                             (!Array.isArray(existingVoteResult.data) && existingVoteResult.data.values?.length > 0));

          if (!voteExists) {
            // Store the properly decrypted vote
            const voteResult = await this.db.query(`
              INSERT INTO poll_votes (
                poll_message_id, poll_option_id, voter_jid, vote_message_id,
                voted_at, sender_timestamp_ms, is_valid, is_encrypted_fallback
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            `, [
              pollMessageId,
              matchingOption.id,
              voterJid,
              `vote_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`, // Generate unique vote ID
              new Date().toISOString(),
              Date.now(),
              1,
              0 // Not a fallback - this is properly decrypted by Baileys
            ]);

            if (voteResult.success) {
            } else {
              console.error('❌ POLL TRACKING: Error storing decrypted vote:', voteResult.error);
            }
          } else {
          }
        }
      }

      return true;
    } catch (error) {
      console.error('❌ POLL TRACKING: Error storing poll votes:', error);
      return false;
    }
  }

  /**
   * Store failed poll vote attempts for analysis
   */
  async storeFailedPollVote(failedVoteData) {
    try {
      const {
        pollMessageId,
        voterJid,
        encryptedData,
        failureReason
      } = failedVoteData;


      // Store the failed vote attempt in a special table or with a flag
      // Note: failure_reason and encrypted_data columns may not exist yet, so we'll use existing columns
      const failedVoteResult = await this.db.query(`
        INSERT INTO poll_votes (
          poll_message_id, poll_option_id, voter_jid, vote_message_id,
          voted_at, sender_timestamp_ms, is_valid, is_encrypted_fallback
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `, [
        pollMessageId,
        null, // No option ID since we couldn't decrypt
        voterJid,
        `failed_vote_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        new Date().toISOString(),
        Date.now(),
        0, // Not valid since we couldn't decrypt
        1  // This is an encrypted fallback
      ]);

      if (failedVoteResult.success) {
        return true;
      } else {
        console.error('❌ POLL TRACKING: Failed to store failed vote attempt');
        return false;
      }
    } catch (error) {
      console.error('❌ POLL TRACKING: Error storing failed poll vote:', error);
      return false;
    }
  }

  /**
   * Get poll message by WhatsApp message ID
   */
  async getPollByMessageId(messageId) {
    try {
      const result = await this.db.query(`
        SELECT * FROM poll_messages WHERE message_id = ?
      `, [messageId]);

      if (!result.success || !result.data) {
        return null;
      }

      const pollData = Array.isArray(result.data) ? result.data[0] :
                      (result.data.values && result.data.values[0]);

      return pollData || null;

    } catch (error) {
      console.error('❌ POLL TRACKING: Error getting poll by message ID:', error);
      return null;
    }
  }

  /**
   * Get poll options for a poll
   */
  async getPollOptions(pollMessageId) {
    try {
      const result = await this.db.query(`
        SELECT id, option_text, option_index, option_hash
        FROM poll_options
        WHERE poll_message_id = ?
        ORDER BY option_index
      `, [pollMessageId]);

      if (!result.success || !result.data) {
        return [];
      }

      return Array.isArray(result.data) ? result.data :
             (result.data.values || []);

    } catch (error) {
      console.error('❌ POLL TRACKING: Error getting poll options:', error);
      return [];
    }
  }



  /**
   * Get comprehensive poll reports data
   */
  async getPollReports(dateRange = null) {
    try {
      let whereClause = 'WHERE pm.is_active = 1';
      let params = [];

      if (dateRange && dateRange.startDate && dateRange.endDate) {
        whereClause += ' AND pm.sent_at >= ? AND pm.sent_at <= ?';
        params.push(dateRange.startDate + ' 00:00:00', dateRange.endDate + ' 23:59:59');
      }

      const result = await this.db.query(`
        SELECT 
          pm.*,
          COUNT(DISTINCT pv.voter_jid) as total_voters,
          COUNT(pv.id) as total_votes,
          mt.name as template_name,
          bc.name as campaign_name,
          ws.device_name
        FROM poll_messages pm
        LEFT JOIN poll_votes pv ON pm.id = pv.poll_message_id AND pv.is_valid = 1
        LEFT JOIN message_templates mt ON pm.template_id = mt.id
        LEFT JOIN bulk_campaigns bc ON pm.campaign_id = bc.id
        LEFT JOIN whatsapp_sessions ws ON pm.session_id = ws.id
        ${whereClause}
        GROUP BY pm.id
        ORDER BY pm.sent_at DESC
      `, params);

      if (!result.success) {
        console.error('❌ POLL TRACKING: Error getting poll reports:', result.error);
        return [];
      }

      return Array.isArray(result.data) ? result.data : 
             (result.data && result.data.values ? result.data.values : []);

    } catch (error) {
      console.error('❌ POLL TRACKING: Error getting poll reports:', error);
      return [];
    }
  }

  /**
   * Get detailed poll results with vote breakdown
   */
  async getPollDetails(pollMessageId) {
    try {
      // Get poll info
      const pollResult = await this.db.query(`
        SELECT pm.*, mt.name as template_name, bc.name as campaign_name
        FROM poll_messages pm
        LEFT JOIN message_templates mt ON pm.template_id = mt.id
        LEFT JOIN bulk_campaigns bc ON pm.campaign_id = bc.id
        WHERE pm.id = ?
      `, [pollMessageId]);

      if (!pollResult.success || !pollResult.data) {
        return null;
      }

      const poll = Array.isArray(pollResult.data) ? pollResult.data[0] : 
                  (pollResult.data.values && pollResult.data.values[0]);

      // Get options with vote counts
      const optionsResult = await this.db.query(`
        SELECT 
          po.*,
          COUNT(pv.id) as vote_count,
          GROUP_CONCAT(pv.voter_jid) as voters
        FROM poll_options po
        LEFT JOIN poll_votes pv ON po.id = pv.poll_option_id AND pv.is_valid = 1
        WHERE po.poll_message_id = ?
        GROUP BY po.id
        ORDER BY po.option_index
      `, [pollMessageId]);

      const options = Array.isArray(optionsResult.data) ? optionsResult.data : 
                     (optionsResult.data && optionsResult.data.values ? optionsResult.data.values : []);

      // Get individual votes
      const votesResult = await this.db.query(`
        SELECT 
          pv.*,
          po.option_text,
          po.option_index
        FROM poll_votes pv
        JOIN poll_options po ON pv.poll_option_id = po.id
        WHERE pv.poll_message_id = ? AND pv.is_valid = 1
        ORDER BY pv.voted_at DESC
      `, [pollMessageId]);

      const votes = Array.isArray(votesResult.data) ? votesResult.data : 
                   (votesResult.data && votesResult.data.values ? votesResult.data.values : []);

      return {
        poll,
        options,
        votes
      };

    } catch (error) {
      console.error('❌ POLL TRACKING: Error getting poll details:', error);
      return null;
    }
  }

  /**
   * Get recent polls for vote checking
   */
  async getRecentPolls(hoursBack = 24) {
    try {
      const cutoffTime = new Date(Date.now() - hoursBack * 60 * 60 * 1000).toISOString();

      const result = await this.db.query(`
        SELECT * FROM poll_messages
        WHERE is_active = 1 AND sent_at >= ?
        ORDER BY sent_at DESC
      `, [cutoffTime]);

      if (result.success) {
        return Array.isArray(result.data) ? result.data :
               (result.data && result.data.values ? result.data.values.map(row => {
                 const columns = result.data.columns;
                 const obj = {};
                 columns.forEach((col, index) => {
                   obj[col] = row[index];
                 });
                 return obj;
               }) : []);
      }

      return [];
    } catch (error) {
      console.error('❌ POLL TRACKING: Error getting recent polls:', error);
      return [];
    }
  }

  /**
   * Get poll analytics summary
   */
  async getPollAnalytics(dateRange = null) {
    try {
      let whereClause = 'WHERE pm.is_active = 1';
      let params = [];

      if (dateRange && dateRange.startDate && dateRange.endDate) {
        whereClause += ' AND pm.sent_at >= ? AND pm.sent_at <= ?';
        params.push(dateRange.startDate + ' 00:00:00', dateRange.endDate + ' 23:59:59');
      }

      const result = await this.db.query(`
        SELECT 
          COUNT(DISTINCT pm.id) as total_polls,
          COUNT(DISTINCT pv.voter_jid) as total_voters,
          COUNT(pv.id) as total_votes,
          AVG(vote_counts.vote_count) as avg_votes_per_poll,
          MAX(vote_counts.vote_count) as max_votes_poll,
          COUNT(DISTINCT pm.campaign_id) as campaigns_with_polls
        FROM poll_messages pm
        LEFT JOIN poll_votes pv ON pm.id = pv.poll_message_id AND pv.is_valid = 1
        LEFT JOIN (
          SELECT poll_message_id, COUNT(*) as vote_count
          FROM poll_votes 
          WHERE is_valid = 1
          GROUP BY poll_message_id
        ) vote_counts ON pm.id = vote_counts.poll_message_id
        ${whereClause}
      `, params);

      if (!result.success) {
        console.error('❌ POLL TRACKING: Error getting poll analytics:', result.error);
        return null;
      }

      return Array.isArray(result.data) ? result.data[0] : 
             (result.data && result.data.values ? result.data.values[0] : null);

    } catch (error) {
      console.error('❌ POLL TRACKING: Error getting poll analytics:', error);
      return null;
    }
  }
}

module.exports = PollTrackingService;
