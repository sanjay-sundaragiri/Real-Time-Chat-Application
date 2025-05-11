process.loadEnvFile()

const express = require('express')
const bodyParser = require('body-parser');
const mongoose= require('mongoose')
const bcrypt= require('bcrypt')
const http= require('http')
const app= express()
const cors = require('cors');
const jwt= require('jsonwebtoken')
const session= require("express-session")
const verifyToken= require('./tokenAuth')
const {Server}= require('socket.io')
const Message = require('./models/Messages')
const GroupMessage = require('./models/GroupMessage');
const Group = require('./models/Group');


app.use(session({
  secret: 'fdsa',
  resave: false,
  saveUninitialized: true,
  cookie: { secure: false }  // Set to `true` if using HTTPS
}));

app.use(cors());
app.use(bodyParser.json());


app.use(express.json());
const User=require('./models/Users')




// //mongoDB connection
// const dbUrl= "mongodb://sanjaysundaragiri:CiSlgPzLO5ytpY8a@cluster01.6y0hdfx.mongodb.net/UserAccounts?retryWrites=true&w=majority"
// const dbUrl = "mongodb+srv://sanjaysundaragiri:VRTAQzfhxdLTjNRo@cluster01.6y0hdfx.mongodb.net/UserAccounts?retryWrites=true&w=majority";
// const uri = "mongodb+srv://Sanjay:YkhvZQ4cIhyeF3HJ@cluster000.xithclt.mongodb.net/userAccounts?retryWrites=true&w=majority&appName=Cluster000";
const uri= process.env.MONGODB_URL




const mongoDBConnection=async()=>{
    try{
     const connect= await mongoose.connect(uri)
     console.log("Connected to the DB ");
    }catch(e){
      console.log("Error: e",e);
    }
}
mongoDBConnection()


const server= http.createServer(app)


const io= new Server(server,{
    cors:{
        origin: process.env.CLIENT_URL || "http://localhost:3000",
        methods:["GET","POST"],
        credentials: true
    },
})

// Store connected users
const connectedUsers = new Map();

io.on("connection",(socket)=>{
    console.log("User connected", socket.id)

    // Handle user login
    socket.on('user-login', (email) => {
        connectedUsers.set(email, socket.id);
        console.log(`User ${email} connected with socket ID: ${socket.id}`);
    });

    // Handle private messages
    socket.on('private-message', async (data) => {
        const { sender, receiver, message } = data;
        
        // Save message to database
        try {
            const newMessage = new Message({
                sender,
                receiver,
                message,
                timestamp: new Date()
            });
            await newMessage.save();
        } catch (error) {
            console.error('Error saving message:', error);
        }

        // Get receiver's socket ID
        const receiverSocketId = connectedUsers.get(receiver);
        
        if (receiverSocketId) {
            // Send message to receiver
            io.to(receiverSocketId).emit('private-message', {
                sender,
                message,
                timestamp: new Date()
            });
        }

        // Send message back to sender for confirmation
        socket.emit('message-sent', {
            receiver,
            message,
            timestamp: new Date()
        });
    });

    // Handle user logout
    socket.on('user-logout', (email) => {
        connectedUsers.delete(email);
        console.log(`User ${email} disconnected`);
    });

    socket.on("disconnect",()=>{
        // Remove user from connected users when they disconnect
        for (let [email, socketId] of connectedUsers.entries()) {
            if (socketId === socket.id) {
                connectedUsers.delete(email);
                console.log(`User ${email} disconnected`);
                break;
            }
        }
    });

    // Handle group messages
    socket.on('group-message', async (data) => {
        const { groupId, sender, message } = data;
        
        try {
            // Save message to database
            const newMessage = new GroupMessage({
                groupId,
                sender,
                message,
                timestamp: new Date()
            });
            await newMessage.save();

            // Get group members
            const group = await Group.findById(groupId);
            if (!group) {
                return;
            }

            // Send message to all group members
            group.members.forEach(member => {
                const memberSocketId = connectedUsers.get(member);
                if (memberSocketId) {
                    io.to(memberSocketId).emit('group-message', {
                        groupId,
                        sender,
                        message,
                        timestamp: new Date()
                    });
                }
            });
        } catch (error) {
            console.error('Error handling group message:', error);
        }
    });

    // Handle group history request
    socket.on('get-group-history', async (data) => {
        const { groupId } = data;
        try {
            const messages = await GroupMessage.find({ groupId })
                .sort({ timestamp: 1 });
            socket.emit('group-history', { messages });
        } catch (error) {
            console.error('Error fetching group history:', error);
        }
    });
});

app.get('/',(req,res)=>{
    res.send('Hi User')
})

app.post('/register',async(req,res)=>{
      try{
        const { name, email, password } = req.body;
        // console.log(req.body)
        //Let the user know, if email already exists and ask the user to enter new email address.
        // const user= await User.findOne({email:email})
        // console.log("user details: ",user)
       
        const hashedPassword = await bcrypt.hash(password,10);
        // console.log(hashedPassword);

        
        
        const newUser= new User({
          name:name,
          email:email,
          password:hashedPassword,
          token:name
        })
       const newUserSaved= await newUser.save();
       res.status(200).json({message:"Registration Successfull"});
      
        //  console.log(newUserSaved);
        
        

      }catch(e){
        console.log('The error:', e); 
        res.status(500).json({ error: 'Internal Server Error' });
      }
})


let loggedUser=null;
app.post('/login', async (req, res) => {
    try {
        const { email, password } = req.body;

        // Input validation
        if (!email || !password) {
            return res.status(400).json({ 
                error: "Email and password are required" 
            });
        }

        // Email format validation
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(email)) {
            return res.status(400).json({ 
                error: "Invalid email format" 
            });
        }

        // Find user
        const user = await User.findOne({ email: email });
        if (!user) {
            return res.status(401).json({ 
                error: "Invalid email or password" 
            });
        }

        // Verify password
        const isPasswordValid = await bcrypt.compare(password, user.password);
        if (!isPasswordValid) {
            return res.status(401).json({ 
                error: "Invalid email or password" 
            });
        }

        // Generate JWT token
        const token = jwt.sign(
            { 
                id: user._id, 
                email: user.email 
            },
            process.env.JWT_SECRET,
            { expiresIn: '24h' } // Token expires in 24 hours
        );

        // Update user token in database
        try {
            await User.updateOne(
                { email: user.email },
                { $set: { token: token } }
            );
        } catch (updateError) {
            console.error('Error updating user token:', updateError);
            // Continue with login even if token update fails
        }

        // Set session
        req.session.user = { email: user.email };
        await req.session.save();

        // Return success response
        res.status(200).json({
            token: token,
            message: "Login successful",
            email: email,
            contacts: user.contacts || [],
            name: user.name
        });

    } catch (error) {
        console.error('Login error:', error);
        
        // Handle specific error types
        if (error.name === 'ValidationError') {
            return res.status(400).json({ 
                error: "Invalid input data" 
            });
        }
        
        if (error.name === 'MongoError') {
            return res.status(503).json({ 
                error: "Database service unavailable" 
            });
        }

        // Generic error response
        res.status(500).json({ 
            error: "An unexpected error occurred during login" 
        });
    }
});

app.post('/reset-password',async(req,res)=>{
   try{
      const{email,password}=req.body;
      console.log(email,password);
      const hashedPassword = await bcrypt.hash(password,10);
      const userPasswordUpdate= await User.findOne({email:email})
      // console.log(userPasswordUpdate)
      await User.updateOne({password:userPasswordUpdate.password},{$set:{password: hashedPassword}})

      return res.status(200).json({message:"Password changed successfully!"})
   }catch(e){
    console.log("Error in reset password: ",e)
    return res.status(404).json({message: "Something is wrong, please enter your details again"})
   }
})

app.post('/save-contact',async(req,res)=>{
      // res.send("Save")
      try{
        const{senderEmail,saveContact,newUserEmail}=req.body;
      console.log("Email  received:",senderEmail,saveContact,newUserEmail)
      if (!saveContact || !senderEmail  || !newUserEmail) {
        return res.status(400).json({ error: "Invalid contact details" });
      }
        const newUser= await User.findOne({email: senderEmail});
        
       if(newUser){
         // Check if the contact already exists
         const contactExists = newUser.contacts.some(
          (c) => c.email === newUserEmail
      );

      if (contactExists) {
          return res.status(400).json({ error: "Contact already exists" });
      }

        newUser.contacts.push({email:newUserEmail,contact:saveContact})    //saving the newly added contacts into an array 
        await newUser.save();
        const updated = await User.findOne({ email: senderEmail });
        console.log(updated);
       }else{
        console.log("user not found")
       }
      
      }catch(e){
        console.log("Error in save-contact",e)
      }

})

// app.get('/get-contacts', async (req, res) => {
//     try {
//         // if (!req.session || !req.session.user || !req.session.user.email) {
//         //     return res.status(401).json({ message: "User not logged in" });
//         // }
//         if (!req.session.user.email) {
//           return res.status(401).json({ message: "User not logged in" });
//         }

//         console.log("Logged User:", req.session.user.email);

//         // const getUserContacts = await User.findOne({ email: req.session.user.email }, 'contacts');
//         const getUserContacts = await User.findOne({ email: loggedUser}, 'contacts');

//         if (!getUserContacts) {
//             return res.status(404).json({ message: "User not found" });
//         }

//         console.log("User Contacts:", getUserContacts.contacts || []);
//         return res.status(200).json({ contacts: getUserContacts.contacts || [] });

//     } catch (error) {
//         console.error("Error fetching contacts:", error);
//         return res.status(500).json({ message: "Internal Server Error" });
//     }
// });

app.get('/get-contacts', async (req, res) => {
  if (!req.session.user) {
    return res.status(401).json({ message: "User not logged in" });
  }

  const user = await User.findOne({ email: req.session.user.email });
  if (!user) {
    return res.status(404).json({ message: "User not found" });
  }

  res.status(200).json({ contacts: user.contacts || [] });
});





app.get('/chat',(req,res)=>{
     res.send("Welocme to the chat application.")
})

app.get('/chat-history', async (req, res) => {
    try {
        const { user1, user2 } = req.query;
        
        if (!user1 || !user2) {
            return res.status(400).json({ error: "Both users must be specified" });
        }

        const messages = await Message.find({
            $or: [
                { sender: user1, receiver: user2 },
                { sender: user2, receiver: user1 }
            ]
        }).sort({ timestamp: 1 });

        res.status(200).json({ messages });
    } catch (error) {
        console.error('Error fetching chat history:', error);
        res.status(500).json({ error: "Internal server error" });
    }
});

// Update Contact
app.put('/update-contact', async (req, res) => {
    try {
        const { userId, contactId, newName, newEmail } = req.body;
        
        if (!userId || !contactId || !newName || !newEmail) {
            return res.status(400).json({ error: "Missing required fields" });
        }

        const user = await User.findOne({ email: userId });
        if (!user) {
            return res.status(404).json({ error: "User not found" });
        }

        // Find and update the contact
        const contactIndex = user.contacts.findIndex(contact => contact.email === contactId);
        if (contactIndex === -1) {
            return res.status(404).json({ error: "Contact not found" });
        }

        // Update contact details
        user.contacts[contactIndex].contact = newName;
        user.contacts[contactIndex].email = newEmail;

        await user.save();
        res.status(200).json({ message: "Contact updated successfully" });
    } catch (error) {
        console.error('Error updating contact:', error);
        res.status(500).json({ error: "Internal server error" });
    }
});

// Delete Contact
app.delete('/delete-contact', async (req, res) => {
    try {
        const { userId, contactId } = req.body;
        
        if (!userId || !contactId) {
            return res.status(400).json({ error: "Missing required fields" });
        }

        const user = await User.findOne({ email: userId });
        if (!user) {
            return res.status(404).json({ error: "User not found" });
        }

        // Remove the contact from the user's contacts array
        user.contacts = user.contacts.filter(contact => contact.email !== contactId);
        
        // Also delete all messages between these users
        await Message.deleteMany({
            $or: [
                { sender: userId, receiver: contactId },
                { sender: contactId, receiver: userId }
            ]
        });

        await user.save();
        res.status(200).json({ message: "Contact deleted successfully" });
    } catch (error) {
        console.error('Error deleting contact:', error);
        res.status(500).json({ error: "Internal server error" });
    }
});

// Block Contact
app.post('/block-contact', async (req, res) => {
    try {
        const { userId, contactId } = req.body;
        
        if (!userId || !contactId) {
            return res.status(400).json({ error: "Missing required fields" });
        }

        const user = await User.findOne({ email: userId });
        if (!user) {
            return res.status(404).json({ error: "User not found" });
        }

        // Find and update the contact's blocked status
        const contactIndex = user.contacts.findIndex(contact => contact.email === contactId);
        if (contactIndex === -1) {
            return res.status(404).json({ error: "Contact not found" });
        }

        user.contacts[contactIndex].isBlocked = true;
        await user.save();

        res.status(200).json({ message: "Contact blocked successfully" });
    } catch (error) {
        console.error('Error blocking contact:', error);
        res.status(500).json({ error: "Internal server error" });
    }
});

// Mute Contact
app.post('/mute-contact', async (req, res) => {
    try {
        const { userId, contactId } = req.body;
        
        if (!userId || !contactId) {
            return res.status(400).json({ error: "Missing required fields" });
        }

        const user = await User.findOne({ email: userId });
        if (!user) {
            return res.status(404).json({ error: "User not found" });
        }

        // Find and update the contact's muted status
        const contactIndex = user.contacts.findIndex(contact => contact.email === contactId);
        if (contactIndex === -1) {
            return res.status(404).json({ error: "Contact not found" });
        }

        user.contacts[contactIndex].isMuted = true;
        await user.save();

        res.status(200).json({ message: "Contact muted successfully" });
    } catch (error) {
        console.error('Error muting contact:', error);
        res.status(500).json({ error: "Internal server error" });
    }
});

// Create new group
app.post('/create-group', async (req, res) => {
    try {
        const { name, creator, members } = req.body;
        
        if (!name || !creator || !members || members.length === 0) {
            return res.status(400).json({ error: "Missing required fields" });
        }

        const newGroup = new Group({
            name,
            creator,
            members: [...members, creator] // Include creator in members
        });

        await newGroup.save();
        res.status(201).json({ group: newGroup });
    } catch (error) {
        console.error('Error creating group:', error);
        res.status(500).json({ error: "Internal server error" });
    }
});

// Get user's groups
app.get('/user-groups', async (req, res) => {
    try {
        const { userId } = req.query;
        
        if (!userId) {
            return res.status(400).json({ error: "User ID is required" });
        }

        const groups = await Group.find({
            members: userId
        });

        res.status(200).json({ groups });
    } catch (error) {
        console.error('Error fetching user groups:', error);
        res.status(500).json({ error: "Internal server error" });
    }
});

// Get group messages
app.get('/group-messages', async (req, res) => {
    try {
        const { groupId } = req.query;
        
        if (!groupId) {
            return res.status(400).json({ error: "Group ID is required" });
        }

        const messages = await GroupMessage.find({ groupId })
            .sort({ timestamp: 1 });

        res.status(200).json({ messages });
    } catch (error) {
        console.error('Error fetching group messages:', error);
        res.status(500).json({ error: "Internal server error" });
    }
});

// Clear individual chat
app.post('/clear-chat', async (req, res) => {
    try {
        const { user1, user2 } = req.body;
        
        if (!user1 || !user2) {
            return res.status(400).json({ error: "Both users must be specified" });
        }

        await Message.deleteMany({
            $or: [
                { sender: user1, receiver: user2 },
                { sender: user2, receiver: user1 }
            ]
        });

        res.status(200).json({ message: "Chat cleared successfully" });
    } catch (error) {
        console.error('Error clearing chat:', error);
        res.status(500).json({ error: "Internal server error" });
    }
});

// Clear group chat
app.post('/clear-group-chat', async (req, res) => {
    try {
        const { groupId } = req.body;
        
        if (!groupId) {
            return res.status(400).json({ error: "Group ID is required" });
        }

        await GroupMessage.deleteMany({ groupId });
        res.status(200).json({ message: "Group chat cleared successfully" });
    } catch (error) {
        console.error('Error clearing group chat:', error);
        res.status(500).json({ error: "Internal server error" });
    }
});

// Leave group
app.post('/leave-group', async (req, res) => {
    try {
        const { groupId, userId } = req.body;
        
        if (!groupId || !userId) {
            return res.status(400).json({ error: "Group ID and user ID are required" });
        }

        const group = await Group.findById(groupId);
        if (!group) {
            return res.status(404).json({ error: "Group not found" });
        }

        // Remove user from members array
        group.members = group.members.filter(member => member !== userId);
        await group.save();

        res.status(200).json({ message: "Left group successfully" });
    } catch (error) {
        console.error('Error leaving group:', error);
        res.status(500).json({ error: "Internal server error" });
    }
});

// Delete group
app.delete('/delete-group', async (req, res) => {
    try {
        const { groupId, userId } = req.body;
        
        if (!groupId || !userId) {
            return res.status(400).json({ error: "Group ID and user ID are required" });
        }

        const group = await Group.findById(groupId);
        if (!group) {
            return res.status(404).json({ error: "Group not found" });
        }

        // Check if user is the creator
        if (group.creator !== userId) {
            return res.status(403).json({ error: "Only the group creator can delete the group" });
        }

        // Delete group and all its messages
        await Group.findByIdAndDelete(groupId);
        await GroupMessage.deleteMany({ groupId });

        res.status(200).json({ message: "Group deleted successfully" });
    } catch (error) {
        console.error('Error deleting group:', error);
        res.status(500).json({ error: "Internal server error" });
    }
});

// Get blocked contacts
app.get('/blocked-contacts', async (req, res) => {
    try {
        const { userId } = req.query;
        
        if (!userId) {
            return res.status(400).json({ error: "User ID is required" });
        }

        const user = await User.findOne({ email: userId });
        if (!user) {
            return res.status(404).json({ error: "User not found" });
        }

        // Get all contacts where isBlocked is true
        const blockedContacts = user.contacts.filter(contact => contact.isBlocked);
        
        res.status(200).json({ blockedContacts });
    } catch (error) {
        console.error('Error getting blocked contacts:', error);
        res.status(500).json({ error: "Internal server error" });
    }
});

// Unblock contact
app.post('/unblock-contact', async (req, res) => {
    try {
        const { userId, contactId } = req.body;
        
        if (!userId || !contactId) {
            return res.status(400).json({ error: "User ID and contact ID are required" });
        }

        const user = await User.findOne({ email: userId });
        if (!user) {
            return res.status(404).json({ error: "User not found" });
        }

        // Update the contact's isBlocked status
        const updatedContacts = user.contacts.map(contact => 
            contact.email === contactId ? { ...contact, isBlocked: false } : contact
        );

        user.contacts = updatedContacts;
        await user.save();

        res.status(200).json({ message: "Contact unblocked successfully" });
    } catch (error) {
        console.error('Error unblocking contact:', error);
        res.status(500).json({ error: "Internal server error" });
    }
});

const PORT=5000;
server.listen(PORT,()=>{
    console.log(`server running at port:${PORT} `)
})

  


// TO delete all the records

// async function deleteAllUsers(){
//     const res= await User.deleteMany({})
//        const res2= await Message.deleteMany({})

// }
// deleteAllUsers();


