import { Notification } from "../models/notification.model.js";

/**
 * Create a notification
 * @param {Object} notificationData - Notification details
 * @returns {Promise<Object>} - Created notification
 */
export const createNotification = async ({
  recipient,
  sender = null,
  type,
  title,
  message,
  data = {},
  order = null,
  gig = null,
  jobPost = null,
  chat = null,
  customOffer = null,
}) => {
  try {
    const notification = await Notification.create({
      recipient,
      sender,
      type,
      title,
      message,
      data,
      order,
      gig,
      jobPost,
      chat,
      customOffer,
      isRead: false,
    });

    // TODO: Emit socket event for real-time notification
    // io.to(recipient).emit('notification', notification);

    return notification;
  } catch (error) {
    console.error("Error creating notification:", error);
    throw error;
  }
};

/**
 * Create multiple notifications
 * @param {Array<Object>} notificationsData - Array of notification details
 * @returns {Promise<Array>} - Created notifications
 */
export const createMultipleNotifications = async (notificationsData) => {
  try {
    const notifications = await Notification.insertMany(notificationsData);

    // TODO: Emit socket events for real-time notifications
    // notificationsData.forEach(notif => {
    //   io.to(notif.recipient).emit('notification', notif);
    // });

    return notifications;
  } catch (error) {
    console.error("Error creating multiple notifications:", error);
    throw error;
  }
};

/**
 * Mark notification as read
 * @param {String} notificationId - Notification ID
 * @returns {Promise<Object>} - Updated notification
 */
export const markNotificationAsRead = async (notificationId) => {
  try {
    const notification = await Notification.findByIdAndUpdate(
      notificationId,
      {
        isRead: true,
        readAt: new Date(),
      },
      { new: true },
    );

    return notification;
  } catch (error) {
    console.error("Error marking notification as read:", error);
    throw error;
  }
};

/**
 * Mark all notifications as read for a user
 * @param {String} userId - User ID
 * @returns {Promise<Object>} - Update result
 */
export const markAllNotificationsAsRead = async (userId) => {
  try {
    const result = await Notification.updateMany(
      { recipient: userId, isRead: false },
      {
        isRead: true,
        readAt: new Date(),
      },
    );

    return result;
  } catch (error) {
    console.error("Error marking all notifications as read:", error);
    throw error;
  }
};

/**
 * Delete notification
 * @param {String} notificationId - Notification ID
 * @returns {Promise<Object>} - Deleted notification
 */
export const deleteNotification = async (notificationId) => {
  try {
    const notification = await Notification.findByIdAndUpdate(
      notificationId,
      { isDeleted: true },
      { new: true },
    );

    return notification;
  } catch (error) {
    console.error("Error deleting notification:", error);
    throw error;
  }
};

/**
 * Get unread notification count
 * @param {String} userId - User ID
 * @returns {Promise<Number>} - Unread count
 */
export const getUnreadNotificationCount = async (userId) => {
  try {
    const count = await Notification.countDocuments({
      recipient: userId,
      isRead: false,
      isDeleted: false,
    });

    return count;
  } catch (error) {
    console.error("Error getting unread notification count:", error);
    throw error;
  }
};

export default {
  createNotification,
  createMultipleNotifications,
  markNotificationAsRead,
  markAllNotificationsAsRead,
  deleteNotification,
  getUnreadNotificationCount,
};
