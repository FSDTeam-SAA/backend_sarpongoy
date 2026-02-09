import catchAsync from "../utils/catchAsync";
import sendResponse from "../utils/sendResponse";

 export const addNewStudent = catchAsync(async(req,res) =>{
    const {schoolName, studentName, studentUserID, studentPassword, confirmStudentPassword,gradeLevel} = req.body;

    if(!schoolName || !studentName || !studentUserID || !studentPassword || !confirmStudentPassword || !gradeLevel){
        sendResponse(res, {
            statusCode: 400,
            success: false,
            message: "All fields are required",
        });

    };

    if(studentPassword !== confirmStudentPassword){
        sendResponse(res, {
            statusCode: 400,
            success: false,
            message: "Passwords do not match",
        });
    }

    




 })